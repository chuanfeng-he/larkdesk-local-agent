# -*- coding: utf-8 -*-
"""上传发票图片 → OCR → 解析字段 → 可复制。"""
import io
import sys

if sys.version_info[0] < 3 or sys.version_info[:2] < (3, 6):
    sys.stderr.write("请使用 Python 3.6+ 运行本程序，例如：python3 app.py\n")
    sys.exit(1)

from typing import Any, Optional, Tuple

import gradio as gr
import numpy as np
from PIL import Image

from parse_invoice import extract_fields

_reader = None  # lazy EasyOCR reader


def get_reader():
    global _reader
    if _reader is None:
        import easyocr

        _reader = easyocr.Reader(["ch_sim", "en"], gpu=False)
    return _reader


def ocr_image(pil: Optional[Image.Image]) -> Tuple[str, str, dict]:
    if pil is None:
        return "", "", {}
    if isinstance(pil, np.ndarray):
        arr = pil
    else:
        buf = io.BytesIO()
        pil.convert("RGB").save(buf, format="PNG")
        buf.seek(0)
        pil = Image.open(buf).convert("RGB")
        arr = np.array(pil)

    reader = get_reader()
    lines = reader.readtext(arr, detail=0, paragraph=False)
    full = "\n".join(lines) if lines else ""

    fields = extract_fields(full)
    # 表格展示用
    table = "\n".join(f"{k}\t{v}" for k, v in fields.items())
    return full, table, fields


def build_ui():
    field_keys = [
        "发票号码",
        "开票日期",
        "购买方名称",
        "销方名称",
        "销方识别号",
        "发票价税合计（小写）",
        "合计金额",
    ]

    def on_upload(img):
        raw, table, fields = ocr_image(img)
        outs = [fields.get(k, "") for k in field_keys]
        return (raw, table, *outs)

    tb_kw = {"lines": 2, "interactive": True}
    try:
        import inspect

        if "show_copy_button" in inspect.signature(gr.Textbox.__init__).parameters:
            tb_kw["show_copy_button"] = True
    except Exception:
        pass

    with gr.Blocks(title="发票字段识别") as demo:
        gr.Markdown(
            "## 发票图片识别（本地 OCR）\n"
            "上传发票截图或照片，自动识别下列字段。**识别为启发式规则，请对照原图核对后再填写。**"
        )
        img = gr.Image(type="pil", label="上传发票图片", sources=["upload", "clipboard"])

        gr.Markdown("### 识别结果（每项右侧可复制；也可框选后 Ctrl+C）")
        boxes = []
        with gr.Row():
            for i in range(0, 7, 2):
                with gr.Column():
                    for j in range(2):
                        idx = i + j
                        if idx < len(field_keys):
                            k = field_keys[idx]
                            b = gr.Textbox(label=k, **tb_kw)
                            boxes.append(b)

        raw_kw = {"lines": 12, "interactive": True}
        tbl_kw = {"lines": 8, "interactive": True}
        if tb_kw.get("show_copy_button"):
            raw_kw["show_copy_button"] = True
            tbl_kw["show_copy_button"] = True
        raw_out = gr.Textbox(label="OCR 全文（可校对）", **raw_kw)
        table_out = gr.Textbox(label="字段汇总（制表符分隔，可粘贴到 Excel）", **tbl_kw)

        img.change(on_upload, img, [raw_out, table_out] + boxes)

        gr.Markdown(
            "---\n"
            "首次运行会下载 EasyOCR 模型，可能较慢。依赖：`pip install -r requirements.txt`。\n"
            "若某字段不准，请从「OCR 全文」里手动复制。"
        )

    return demo


if __name__ == "__main__":
    build_ui().launch(server_name="127.0.0.1", server_port=7860, share=False)
