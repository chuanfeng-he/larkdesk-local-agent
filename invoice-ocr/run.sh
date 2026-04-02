#!/usr/bin/env bash
# 避免 PATH 里 python 指向 Python 2（常见于老 Anaconda）
cd "$(dirname "$0")"
exec python3 app.py "$@"
