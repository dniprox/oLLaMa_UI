#!/bin/bash

# Автоматично беремо шлях з вашої змінної OLLAMA_MODELS, або ../models/ за замовчуванням
OLLAMA_BASE_DIR="${OLLAMA_MODELS:-../models/}"
OLLAMA_BASE_DIR=$(realpath "$OLLAMA_BASE_DIR")

OLLAMA_MANIFESTS="$OLLAMA_BASE_DIR/manifests"
OLLAMA_BLOBS="$OLLAMA_BASE_DIR/blobs"

# Папка для красивих лінків
TARGET_DIR="$HOME/llama_models"
mkdir -p "$TARGET_DIR"

echo "=== ТОЧНЕ СКАНУВАННЯ ТА СТВОРЕННЯ ПОСИЛАНЬ ==="
echo "База Ollama: $OLLAMA_BASE_DIR"
echo "Цільова папка: $TARGET_DIR"
echo "--------------------------------------------------"

if [ ! -d "$OLLAMA_MANIFESTS" ]; then
    echo "❌ Помилка: Папку маніфестів не знайдено за шляхом $OLLAMA_MANIFESTS"
    exit 1
fi

# Глибокий пошук усіх файлів маніфестів (ігноруємо структуру папок репозиторіїв)
find "$OLLAMA_MANIFESTS" -type f | while read -r manifest; do

    # Визначаємо красиве ім'я файлу на основі структури папок Ollama
    # Наприклад: .../registry.ollama.ai/library/qwen2.5-coder/7b -> qwen2.5-coder-7b
    # Вирізаємо все аж до папки 'library/' або аналогічної
    model_part=$(echo "$manifest" | sed -E 's|.*/manifests/[^/]+/([^/]+/)?||')
    model_name=$(echo "$model_part" | tr '/' '-')

    # КРИТИЧНЕ ВИПРАВЛЕННЯ: дістаємо SHA саме шару моделі (application/vnd.ollama.image.model)
    sha_hash=$(jq -r '.layers[] | select(.mediaType == "application/vnd.ollama.image.model") | .digest' "$manifest" 2>/dev/null)

    # Якщо за специфікацією тип не вказано, беремо найбільший шар (запасний варіант)
    if [ -z "$sha_hash" ] || [ "$sha_hash" == "null" ]; then
        sha_hash=$(jq -r '.layers | sort_by(.size) | last | .digest' "$manifest" 2>/dev/null)
    fi

    # Очищаємо префікс "sha256:"
    sha_hash=${sha_hash#sha256:}

    if [ -n "$sha_hash" ] && [ "$sha_hash" != "null" ]; then
        # Перевіряємо два можливі формати імен у блобах (з дефісом та двокрапкою)
        source_file1="$OLLAMA_BLOBS/sha256-$sha_hash"
        source_file2="$OLLAMA_BLOBS/sha256:$sha_hash"

        if [ -f "$source_file1" ]; then
            source_file="$source_file1"
        elif [ -f "$source_file2" ]; then
            source_file="$source_file2"
        else
            source_file=""
        fi

        target_link="$TARGET_DIR/${model_name}.gguf"

        if [ -n "$source_file" ]; then
            rm -f "$target_link"
            ln -s "$source_file" "$target_link"
            echo "✅ Знайдено: ${model_name}.gguf"
        else
            echo "⚠️  Файл ваг для [$model_name] відсутній у blobs (можливо, недовантажений)."
        fi
    fi
done

echo "--------------------------------------------------"
echo "Готово! Створено посилань: $(ls -1 "$TARGET_DIR" | wc -l)"
echo "Перевірте папку: ls -lh $TARGET_DIR"
