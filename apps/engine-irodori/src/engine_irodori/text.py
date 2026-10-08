from __future__ import annotations

SENTENCE_ENDS = set("。．！？!?")
# 文末記号の直後に続く閉じ括弧・引用符は前の文に含める
CLOSERS = set("」』）)】〉》\"'”’")
SOFT_BREAKS = set("、，,")

MIN_CHARS = 6
MAX_CHARS = 160


def _split_sentences(text: str) -> list[str]:
    pieces: list[str] = []
    current: list[str] = []
    i = 0
    while i < len(text):
        char = text[i]
        if char in "\r\n":
            pieces.append("".join(current))
            current = []
            i += 1
            continue
        current.append(char)
        i += 1
        if char in SENTENCE_ENDS:
            while i < len(text) and (text[i] in SENTENCE_ENDS or text[i] in CLOSERS):
                current.append(text[i])
                i += 1
            pieces.append("".join(current))
            current = []
    pieces.append("".join(current))
    return [piece.strip() for piece in pieces if piece.strip()]


def _split_long(sentence: str, max_chars: int) -> list[str]:
    if len(sentence) <= max_chars:
        return [sentence]
    parts: list[str] = []
    current = ""
    for char in sentence:
        current += char
        if len(current) >= max_chars or (char in SOFT_BREAKS and len(current) >= max_chars // 2):
            parts.append(current)
            current = ""
    if current:
        parts.append(current)
    return parts


def split_segments(text: str, *, min_chars: int = MIN_CHARS, max_chars: int = MAX_CHARS) -> list[str]:
    """読み上げ文を「。！？」と改行で区切る。短すぎる断片は次と結合し、長すぎる文は読点で割る。"""
    sentences: list[str] = []
    for sentence in _split_sentences(text):
        sentences.extend(_split_long(sentence, max_chars))

    segments: list[str] = []
    pending = ""
    for sentence in sentences:
        pending += sentence
        if len(pending) >= min_chars:
            segments.append(pending)
            pending = ""
    if pending:
        if segments and len(segments[-1]) + len(pending) <= max_chars:
            segments[-1] += pending
        else:
            segments.append(pending)
    return segments
