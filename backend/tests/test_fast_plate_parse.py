"""Robustness tests for the fast-plate-ocr result adapter."""

import numpy as np

from app.services.visionflow_engine import SpeedEstimator


parse = SpeedEstimator._parse_fast_plate_result


def test_parse_list_of_strings():
    text, conf = parse(["3574BNW"])
    assert text == "3574BNW"
    assert conf > 0


def test_parse_plain_string():
    text, conf = parse("8934FMR")
    assert text == "8934FMR"
    assert conf > 0


def test_parse_tuple_texts_and_confidences():
    text, conf = parse((["3693FSG"], np.array([0.9, 0.95, 0.8])))
    assert text == "3693FSG"
    assert 0.7 < conf <= 1.0


def test_parse_strips_padding_and_symbols():
    text, _ = parse(["__3574BNW_"])
    assert text == "3574BNW"


def test_parse_object_with_plate_attr():
    class R:
        plate = "0262HFP"
        plate_prob = [0.99, 0.98]

    text, conf = parse([R()])
    assert text == "0262HFP"
    assert conf > 0.9


def test_parse_plate_prediction_char_probs():
    # Mirrors fast_plate_ocr.core.types.PlatePrediction
    class PlatePrediction:
        def __init__(self):
            self.plate = "3574BNW"
            self.char_probs = np.array([0.99, 0.98, 0.999, 0.97, 0.99, 0.95, 0.98])
            self.region = None
            self.region_prob = None

    text, conf = parse([PlatePrediction()])
    assert text == "3574BNW"
    assert conf > 0.9


def test_parse_empty_returns_blank():
    assert parse([""]) == ("", 0.0)
    assert parse([]) == ("", 0.0)
