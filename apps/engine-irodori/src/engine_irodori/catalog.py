from __future__ import annotations

from dataclasses import dataclass

QUANT_SCHEMES = (
    "int8-weight-only",
    "int8-dynamic",
    "int4-weight-only",
    "float8-weight-only",
    "float8-dynamic",
)


@dataclass(frozen=True)
class ModelSpec:
    id: str
    # Hugging Face の repo id。量子化版は repo_id/サブフォルダ
    checkpoint: str
    family: str
    description: str
    license: str
    weights_gb: float


def _family(
    *,
    prefix: str,
    family: str,
    repo: str,
    label: str,
    license: str,
    weights_gb: float,
    quant_weights_gb: dict[str, float],
    extra: tuple[ModelSpec, ...] = (),
) -> list[ModelSpec]:
    specs = [
        ModelSpec(
            id=prefix,
            checkpoint=repo,
            family=family,
            description=f"{label}（非量子化）",
            license=license,
            weights_gb=weights_gb,
        ),
        *extra,
    ]
    for scheme in QUANT_SCHEMES:
        specs.append(
            ModelSpec(
                id=f"{prefix}-{scheme}",
                checkpoint=f"{repo}-Quantized/{scheme}",
                family=family,
                description=f"{label}（{scheme} 量子化）",
                license=license,
                weights_gb=quant_weights_gb[scheme],
            )
        )
    return specs


MODELS: tuple[ModelSpec, ...] = (
    *_family(
        prefix="irodori-v4.1-small",
        family="v4.1-small",
        repo="Aratako/Irodori-TTS-v4.1-Small",
        label="Irodori-TTS v4.1 Small 0.8B",
        license="MIT",
        weights_gb=3.06,
        quant_weights_gb={
            "int8-weight-only": 0.91,
            "int8-dynamic": 0.91,
            "int4-weight-only": 0.85,
            "float8-weight-only": 0.92,
            "float8-dynamic": 0.95,
        },
        extra=(
            ModelSpec(
                id="irodori-v4.1-small-mf",
                checkpoint="Aratako/Irodori-TTS-v4.1-Small-MF",
                family="v4.1-small",
                description="Irodori-TTS v4.1 Small 0.8B（MeanFlow 蒸留・少ステップ）",
                license="MIT",
                weights_gb=3.09,
            ),
        ),
    ),
    *_family(
        prefix="irodori-v4-large",
        family="v4-large",
        repo="Aratako/Irodori-TTS-v4-Large",
        label="Irodori-TTS v4 Large 3.29B",
        license="Gemma Terms of Use",
        weights_gb=13.15,
        quant_weights_gb={
            "int8-weight-only": 3.84,
            "int8-dynamic": 3.84,
            "int4-weight-only": 2.96,
            "float8-weight-only": 3.84,
            "float8-dynamic": 3.84,
        },
    ),
    *_family(
        prefix="irodori-v4-small",
        family="v4-small",
        repo="Aratako/Irodori-TTS-v4-Small",
        label="Irodori-TTS v4 Small 0.8B（v4.1 の前版）",
        license="MIT",
        weights_gb=3.06,
        quant_weights_gb={
            "int8-weight-only": 0.91,
            "int8-dynamic": 0.91,
            "int4-weight-only": 0.85,
            "float8-weight-only": 0.92,
            "float8-dynamic": 0.95,
        },
    ),
)

MODELS_BY_ID: dict[str, ModelSpec] = {spec.id: spec for spec in MODELS}
