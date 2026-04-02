#!/usr/bin/env bash
# 安装发票 OCR 工具依赖（Python 3，CPU 版 PyTorch）
set -e
cd "$(dirname "$0")"
PY="${PYTHON:-python3}"

echo "==> 升级 pip"
"$PY" -m pip install --user --upgrade pip setuptools wheel

echo "==> 安装 CPU 版 PyTorch（避免默认装 CUDA 版，体积数 GB）"
"$PY" -m pip install --user torch torchvision --index-url https://download.pytorch.org/whl/cpu

echo "==> 安装 Gradio、EasyOCR 等"
"$PY" -m pip install --user -i https://pypi.org/simple -r requirements.txt

echo "完成。运行: $PY app.py"
