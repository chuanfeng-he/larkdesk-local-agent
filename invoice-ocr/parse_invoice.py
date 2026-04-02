# -*- coding: utf-8 -*-
"""从 OCR 全文里尽量抽取增值税/数电发票常见字段（启发式，不保证 100% 准确）。"""
import re
from typing import Dict


def _norm(s: str) -> str:
    return (
        s.replace(" ", "")
        .replace("　", "")
        .replace("：", ":")
        .replace("（", "(")
        .replace("）", ")")
    )


def extract_fields(ocr_text: str) -> Dict[str, str]:
    text = ocr_text or ""
    n = _norm(text)
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    joined = "\n".join(lines)

    out: Dict[str, str] = {
        "发票号码": "",
        "开票日期": "",
        "购买方名称": "",
        "销方名称": "",
        "销方识别号": "",
        "发票价税合计（小写）": "",
        "合计金额": "",
    }

    # 发票号码：8/12/20 位数字，或紧跟「发票号码」「No」
    for pat in (
        r"(?:发票号码|电子发票号码|发票No\.?|No\.?)[:\s]*(\d{8,20})",
        r"(?<![0-9])(\d{20})(?![0-9])",  # 数电 20 位
        r"(?<![0-9])(\d{12})(?![0-9])",
        r"(?<![0-9])(\d{8})(?![0-9])",
    ):
        m = re.search(pat, n, re.I)
        if m:
            out["发票号码"] = m.group(1)
            break

    # 开票日期
    dm = re.search(
        r"(?:开票日期|开具日期|日期)[:\s]*(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})[日]?",
        n,
    )
    if dm:
        y, mo, d = dm.group(1), int(dm.group(2)), int(dm.group(3))
        out["开票日期"] = f"{y}年{mo:02d}月{d:02d}日"
    else:
        dm2 = re.search(r"(\d{4})[年\-/](\d{1,2})[月\-/](\d{1,2})[日]?", n)
        if dm2:
            y, mo, d = dm2.group(1), int(dm2.group(2)), int(dm2.group(3))
            out["开票日期"] = f"{y}年{mo:02d}月{d:02d}日"

    # 购买方名称 / 销方名称：标签后同一行或下一行
    def after_label(block: str, labels: tuple) -> str:
        for lb in labels:
            idx = block.find(lb)
            if idx == -1:
                continue
            rest = block[idx + len(lb) :].lstrip(" :\t")
            # 取到换行前，去掉常见后缀字段名
            one = rest.split("\n")[0].strip()
            for stop in ("纳税人识别号", "统一社会信用代码", "地址", "电话", "开户行", "账号"):
                p = one.find(stop)
                if p != -1:
                    one = one[:p].strip()
            if one and not re.fullmatch(r"[\d\s\-]+", one):
                return one[:200]
        return ""

    # 分块：购买方 / 销售方 信息区
    buy_block = ""
    sell_block = ""
    if "购买方信息" in joined or "购" in joined:
        i = joined.find("购买方")
        if i != -1:
            j = joined.find("销售方", i)
            buy_block = joined[i : j if j != -1 else i + 800]
    if "销售方信息" in joined or "销方" in joined:
        i = joined.find("销售方")
        if i != -1:
            sell_block = joined[i : i + 1200]

    out["购买方名称"] = after_label(
        buy_block or joined,
        ("名称", "购买方名称", "名称为"),
    )
    # 若购买方块里「名称」被销方占用，尝试第二处「名称」
    if not out["购买方名称"]:
        names = list(re.finditer(r"名称[:\s]*([^\n]+)", n))
        if len(names) >= 1:
            out["购买方名称"] = names[0].group(1).strip()[:200]

    out["销方名称"] = after_label(
        sell_block or joined,
        ("名称", "销售方名称", "销方名称"),
    )
    if not out["销方名称"]:
        names = list(re.finditer(r"名称[:\s]*([^\n]+)", n))
        if len(names) >= 2:
            out["销方名称"] = names[1].group(1).strip()[:200]
        elif len(names) == 1 and out["购买方名称"] and names[0].group(1).strip() != out["购买方名称"]:
            out["销方名称"] = names[0].group(1).strip()[:200]

    # 纳税人识别号 / 统一社会信用代码：18 位或 15 位老税号
    tax_ids = re.findall(r"(?<![0-9A-Za-z])([0-9A-Z]{15}|[0-9A-Z]{18}|[0-9A-Z]{20})(?![0-9A-Za-z])", n)
    # 过滤全 0
    tax_ids = [t for t in tax_ids if not re.fullmatch(r"0+", t)]
    if len(tax_ids) >= 2:
        # 通常先购后方销方
        out["销方识别号"] = tax_ids[-1][:20]
    elif len(tax_ids) == 1:
        out["销方识别号"] = tax_ids[0]

    # 价税合计（小写）
    for pat in (
        r"(?:价税合计|价税合计（小写）|价税合计\(小写\))[（(小写)）:：\s]*[¥￥]?\s*([\d,，]+\.?\d*)",
        r"[¥￥]\s*([\d,，]+\.?\d*)\s*(?:小写)?",
    ):
        m = re.search(pat, n)
        if m:
            out["发票价税合计（小写）"] = m.group(1).replace(",", "").replace("，", "")
            break
    if not out["发票价税合计（小写）"]:
        m = re.search(r"(?:合计|价税合计)[:\s]*[¥￥]?\s*([\d,，]+\.?\d*)", n)
        if m:
            out["发票价税合计（小写）"] = m.group(1).replace(",", "").replace("，", "")

    # 合计金额（不含税）
    for pat in (
        r"(?:合计金额|金额合计|合计)[（(不含税)）:：\s]*[¥￥]?\s*([\d,，]+\.?\d*)",
        r"￥\s*([\d,，]+\.?\d*)\s*(?:合计金额)?",
    ):
        m = re.search(pat, n)
        if m:
            val = m.group(1).replace(",", "").replace("，", "")
            if val != out["发票价税合计（小写）"]:
                out["合计金额"] = val
                break

    return out
