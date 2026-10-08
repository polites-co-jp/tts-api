from engine_irodori.text import split_segments


def test_splits_on_sentence_ends_and_newlines() -> None:
    text = "今日はいい天気ですね。散歩に行きましょうか！\nそれとも家にいますか？"
    assert split_segments(text) == [
        "今日はいい天気ですね。",
        "散歩に行きましょうか！",
        "それとも家にいますか？",
    ]


def test_keeps_closing_brackets_with_sentence() -> None:
    assert split_segments("彼は「行くよ。」と言った。そして出かけた。") == [
        "彼は「行くよ。」",
        "と言った。そして出かけた。",
    ]


def test_merges_short_fragments_with_next() -> None:
    assert split_segments("はい。わかりました、すぐ行きます。") == ["はい。わかりました、すぐ行きます。"]


def test_trailing_short_fragment_joins_previous() -> None:
    assert split_segments("それではまた明日お会いしましょう。では。") == ["それではまた明日お会いしましょう。では。"]


def test_long_sentence_is_split_on_commas() -> None:
    sentence = "、".join(["これはとても長い文の一部です"] * 20) + "。"
    segments = split_segments(sentence, max_chars=60)
    assert len(segments) > 1
    assert all(len(s) <= 60 for s in segments)
    assert "".join(segments) == sentence


def test_text_without_punctuation_is_one_segment() -> None:
    assert split_segments("句読点のない文") == ["句読点のない文"]
