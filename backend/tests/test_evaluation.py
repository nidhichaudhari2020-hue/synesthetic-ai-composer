import math

import pytest

from app.ml.evaluate import baseline_scores, sha256, verify_split
from app.ml.tokenizer import VOCAB_SIZE
from app.ml.train import split_files


def test_train_only_smoothing_for_observed_transition_and_unseen_context():
    scores = baseline_scores([([0, 1], [1, 0])], [([1, 2], [0, 1])])
    assert scores["unigram"]["cross_entropy_nats_per_token"] == pytest.approx(-math.log(2 / (2 + VOCAB_SIZE)))
    expected_bigram = -(math.log(2 / (1 + VOCAB_SIZE)) + math.log(1 / VOCAB_SIZE)) / 2
    assert scores["bigram"]["cross_entropy_nats_per_token"] == pytest.approx(expected_bigram)
    assert scores["bigram"]["predicted_tokens"] == 2


def test_split_verification_rejects_modified_file(tmp_path):
    paths = [tmp_path / f"{name}.mid" for name in ("a", "b", "c")]
    for path in paths:
        path.write_bytes(path.name.encode())
    train, validation = split_files(paths, 42)
    def records(group):
        return [{"name": p.name, "sha256": sha256(p)} for p in group]
    manifest = {"seed": 42, "train_files": records(train), "validation_files": records(validation)}
    paths[0].write_bytes(b"changed")
    with pytest.raises(ValueError, match="hash or split mismatch"):
        verify_split(tmp_path, manifest)
