const chatWindow = document.getElementById('chat-window');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const stopBtn = document.getElementById('stop-btn');
const ctxInput = document.getElementById('ctx-size');
const modelList = document.getElementById('model-list');

let selectedModelName = "";
let currentBase64 = null;
let controller = null; // Для зупинки генерації

marked.setOptions({
    highlight: (code) => hljs.highlightAuto(code).value,
    breaks: true
});

// --- РОЗУМНИЙ СКРОЛ ---
function scrollToBottom() {
    const threshold = 150;
    const isAtBottom = chatWindow.scrollHeight - chatWindow.scrollTop - chatWindow.clientHeight <= threshold;
    if (isAtBottom) {
        chatWindow.scrollTop = chatWindow.scrollHeight;
    }
}

// --- МОДЕЛІ ТА СТАТУС ---

let currentSort = 'name'; // 'name' або 'size'

function setSort(type) {
    currentSort = type;
    document.getElementById('sort-name').classList.toggle('active', type === 'name');
    document.getElementById('sort-size').classList.toggle('active', type === 'size');
    loadModels(); // Перемальовуємо список
}

async function loadModels() {
    const baseUrl = document.getElementById('api-url').value.trim();
    try {
        const r = await fetch(`${baseUrl}/api/tags`);
        const d = await r.json();
        const listContainer = document.getElementById('model-list');
        listContainer.innerHTML = '';

        if (d.models) {
            // СОРТУВАННЯ
            let sortedModels = [...d.models];
            if (currentSort === 'name') {
                sortedModels.sort((a, b) => a.name.localeCompare(b.name));
            } else {
                // Від більших до менших
                sortedModels.sort((a, b) => b.size - a.size);
            }

            sortedModels.forEach(m => {
                const safeId = m.name.replace(/:/g, '-');
                const btn = document.createElement('button');
                btn.className = `model-btn ${m.name === selectedModelName ? 'active' : ''}`;
                btn.id = `btn-${safeId}`;
                btn.innerHTML = `
                    <div>${m.name}</div>
                    <div style="font-size:10px; opacity:0.5">${(m.size/1e9).toFixed(1)} GB</div>
                `;
                btn.onclick = () => selectModel(m.name);
                listContainer.appendChild(btn);
            });
        }
    } catch (e) { console.error(e); }
}

async function selectModel(name) {
    selectedModelName = name;
    document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.getElementById(`btn-${name.replace(/:/g, '-')}`);
    if (activeBtn) activeBtn.classList.add('active');

    // Отримуємо контекст моделі
    const baseUrl = document.getElementById('api-url').value.trim();
    try {
        const r = await fetch(`${baseUrl}/api/show`, { method: 'POST', body: JSON.stringify({ name }) });
        const d = await r.json();
        const ctxMatch = ((d.parameters || "") + (d.modelfile || "")).match(/num_ctx\s+(\d+)/i);
        ctxInput.value = ctxMatch ? ctxMatch[1] : (d.model_info?.["llama.context_length"] || 4096);
    } catch (e) { ctxInput.value = 4096; }
}

// --- ВІДПРАВКА ПОВІДОМЛЕННЯ ---
async function sendMessage(overrideText = null) {
    const rawText = overrideText || userInput.value.trim();
    if (!rawText && !currentBase64) return;

    // Налаштування API
    let baseUrl = document.getElementById('api-url').value.trim().replace(/\/\$/, "");
    const apiType = document.getElementById('api-type').value;
    const ctx = parseInt(ctxInput.value);
    const useCPU = document.getElementById('force-cpu').checked;

    // Зберігаємо налаштування
    localStorage.setItem('ollama_api_url', baseUrl);
    localStorage.setItem('ollama_api_type', apiType);

    // Форматування коду
    let displayText = rawText;
    if (rawText.includes('\n') || rawText.includes('{') || rawText.includes(';')) {
        if (!rawText.startsWith('```')) displayText = "```\n" + rawText + "\n```";
    }

    renderMessage(displayText, true, '', currentBase64);
    saveMsg('user', displayText, '', currentBase64);
    if (!overrideText) userInput.value = '';

    sendBtn.disabled = true;
    stopBtn.style.display = 'inline-block';
    const botDiv = renderMessage("...", false, selectedModelName);
    let fullText = "";

    // Контролер зупинки
    controller = new AbortController();
    stopBtn.onclick = () => controller.abort();

    // Показуємо кнопку Stop та ховаємо Send під час генерації
    stopBtn.style.display = 'inline-block';
    sendBtn.disabled = true;

    // Налаштовуємо дію кнопки Stop
    stopBtn.onclick = () => {
        if (controller) {
            controller.abort(); // Це обриває fetch запит
            console.log("Генерацію зупинено користувачем");
        }
    };


    try {
        const isOllama = apiType === 'ollama';
        const endpoint = isOllama ? `${baseUrl}/api/generate` : `${baseUrl}/v1/chat/completions`;
        const payload = isOllama ? {
            model: selectedModelName, prompt: rawText, stream: true,
            images: currentBase64 ? [currentBase64] : [],
            options: { num_ctx: ctx, num_gpu: useCPU ? 0 : undefined }
        } : {
            model: selectedModelName, stream: true,
            messages: [{ role: "user", content: rawText }]
        };

        const response = await fetch(endpoint, {
            method: 'POST',
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        botDiv.innerHTML = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');

            for (let line of lines) {
                if (!line.trim()) continue;
                try {
                    if (isOllama) {
                        const json = JSON.parse(line);
                        if (json.response) fullText += json.response;
                    } else if (line.startsWith('data: ')) {
                        const clean = line.replace('data: ', '').trim();
                        if (clean === '[DONE]') break;
                        const json = JSON.parse(clean);
                        const content = json.choices[0]?.delta?.content;
                        if (content) fullText += content;
                    }
                } catch (e) { }
            }
            botDiv.innerHTML = marked.parse(fullText);
            processCode(botDiv);
            scrollToBottom();
        }
        saveMsg('bot', fullText, selectedModelName);
    } catch (e) {
        if (e.name === 'AbortError') {
           botDiv.innerHTML += "<br><i>[Зупинено користувачем]</i>";
           // Додаємо помітку в чат, що зупинено
           //const lastBotMsg = chatWindow.querySelector('.bot-message:last-child div:last-child');
           //if (lastBotMsg) lastBotMsg.innerHTML += " <br><i>[Зупинено]</i>";
        }
        else {
                console.error("Помилка:", e);
                botDiv.textContent = "Помилка зв'язку. Перевірте URL та CORS.";
        }
    } finally {
        sendBtn.disabled = false;
        stopBtn.style.display = 'none';
        controller = null;
        clearImage();
    }
}

// --- ДОПОМІЖНІ ФУНКЦІЇ ---
function processCode(container) {
    container.querySelectorAll('pre').forEach(pre => {
        if (pre.parentElement.classList.contains('code-wrapper')) return;
        const w = document.createElement('div'); w.className = 'code-wrapper';
        pre.parentNode.insertBefore(w, pre); w.appendChild(pre);
        const b = document.createElement('button'); b.className = 'copy-btn'; b.textContent = 'Copy';
        b.onclick = () => {
            navigator.clipboard.writeText(pre.innerText.replace('Copy', ''));
            b.textContent = "Copied!"; setTimeout(() => b.textContent = "Copy", 2000);
        };
        w.appendChild(b);
        hljs.highlightElement(pre.querySelector('code'));
    });
}

function renderMessage(content, isUser, model = '', img = null) {
    const div = document.createElement('div');
    div.className = `message ${isUser ? 'user-message' : 'bot-message'}`;
    if (!isUser) div.innerHTML = `<span class="model-tag">${model}</span>`;
    if (img) div.innerHTML += `<img src="data:image/png;base64,${img}" class="msg-img">`;
    const wrap = document.createElement('div');
    wrap.innerHTML = isUser ? content : marked.parse(content);
    div.appendChild(wrap);
    chatWindow.appendChild(div);
    processCode(wrap);
    chatWindow.scrollTop = chatWindow.scrollHeight;
    return wrap;
}

function saveMsg(role, content, model, img) {
    const h = JSON.parse(localStorage.getItem('ollama_history') || '[]');
    h.push({ role, content, model, img });
    localStorage.setItem('ollama_history', JSON.stringify(h));
}

function loadHistory() {
    const h = JSON.parse(localStorage.getItem('ollama_history') || '[]');
    h.forEach(m => renderMessage(m.content, m.role === 'user', m.model, m.img));
}

window.clearHistory = () => { if(confirm("Очистити чат?")) { localStorage.removeItem('ollama_history'); chatWindow.innerHTML = ''; } };

document.getElementById('file-input').onchange = e => {
    const reader = new FileReader();
    reader.onload = () => {
        currentBase64 = reader.result.split(',')[1];
        document.getElementById('preview-img').src = reader.result;
        document.getElementById('preview-container').style.display = 'flex';
    };
    reader.readAsDataURL(e.target.files);
};


function toggleTheme() {
    const isDark = document.body.classList.toggle('dark-mode');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
    document.getElementById('theme-icon').textContent = isDark ? '☀️' : '🌙';
}

// Додайте це всередину window.onload
const savedTheme = localStorage.getItem('theme');
if (savedTheme === 'dark') {
    document.body.classList.add('dark-mode');
    document.getElementById('theme-icon').textContent = '☀️';
}


function clearImage() { currentBase64 = null; document.getElementById('preview-container').style.display = 'none'; }

// ВІДНОВЛЕННЯ НАЛАШТУВАНЬ
window.onload = () => {
    const savedUrl = localStorage.getItem('ollama_api_url');
    const savedType = localStorage.getItem('ollama_api_type');
    if (savedUrl) document.getElementById('api-url').value = savedUrl;
    if (savedType) document.getElementById('api-type').value = savedType;
    loadModels();
    loadHistory();
};

sendBtn.onclick = () => sendMessage();
userInput.onkeypress = e => { if (e.key === 'Enter') sendMessage(); };
