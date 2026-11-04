from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

import numpy as np


_EXCLUDED = {'"', "\\", ",", ";", "<", ">", "|"}
_ALPHABET = "".join(chr(code) for code in range(0x21, 0x7F) if chr(code) not in _EXCLUDED)
_RADIX = 85
_PREFIX_LEN = 5
_CHAR_VALS = {ch: idx for idx, ch in enumerate(_ALPHABET)}
_MASK32 = 0xFFFFFFFF
_TOP = 1 << 24
_BOTTOM = 1 << 16
_PADDING = 2
_CONTEXT_COUNT = 1 << 12
_INCREMENT = 14
_COUNT_LIMIT = 4096

_FRAME_HEADER_RE = re.compile(r"^<(\d+)f(?:;([^>]*))?>(.*)$")
_RECORD_START_RE = re.compile(r",?([0-9]+)(?=<\|)")
_TOKEN_RE = re.compile(r"<\|([A-Za-z][A-Za-z0-9_.-]*)(?:;([^|]*))?\|>")
_MASK_DATA_RE = re.compile(r"^([0-9]+),([0-9]+),([!~][^|]+)$")


class SamMaskDecodeError(ValueError):
    """Raised when a SAM 3.1 mask token cannot be decoded safely."""


@dataclass(frozen=True)
class ParsedSamCandidate:
    object_id: int
    box_xyxy: Tuple[int, int, int, int]  # (left, top, right_exclusive, bottom_exclusive)
    source_width: int
    source_height: int
    mask: np.ndarray  # shape: (source_height, source_width), dtype uint8 {0, 1}
    confidence: Optional[float] = None


def _digit(ch: str) -> int:
    val = _CHAR_VALS.get(ch, -1)
    if val < 0 or val >= _RADIX:
        raise SamMaskDecodeError("Mask payload contains an invalid base-85 character.")
    return val


def unpack_base85(payload: str) -> bytes:
    if len(payload) < _PREFIX_LEN:
        raise SamMaskDecodeError("Mask payload is missing its length prefix.")
    length = 0
    for i in range(_PREFIX_LEN):
        length = length * _RADIX + _digit(payload[i])
    if length < 0 or length > 64_000_000:
        raise SamMaskDecodeError("Mask payload length is out of bounds.")
    rem = length % 4
    expected = _PREFIX_LEN + (length // 4) * 5 + (0 if rem == 0 else rem + 1)
    if len(payload) != expected:
        raise SamMaskDecodeError("Mask payload length does not match its prefix.")
    out = bytearray(length)
    src = _PREFIX_LEN
    dst = 0
    full = length - rem
    while dst < full:
        val = 0
        for i in range(5):
            val = val * _RADIX + _digit(payload[src + i])
        if val > _MASK32:
            raise SamMaskDecodeError("Mask payload contains an out-of-range group.")
        src += 5
        out[dst] = (val >> 24) & 0xFF
        out[dst + 1] = (val >> 16) & 0xFF
        out[dst + 2] = (val >> 8) & 0xFF
        out[dst + 3] = val & 0xFF
        dst += 4
    if rem > 0:
        val = 0
        for i in range(5):
            d = _digit(payload[src + i]) if i < rem + 1 else (_RADIX - 1)
            val = val * _RADIX + d
        if val > _MASK32:
            raise SamMaskDecodeError("Mask payload contains an out-of-range tail.")
        for i in range(rem):
            out[dst + i] = (val >> (24 - i * 8)) & 0xFF
    return bytes(out)


class _RangeDecoder:
    def __init__(self, data: bytes):
        if len(data) < 4:
            raise SamMaskDecodeError("Mask payload is missing its range-coder finalization.")
        self._data = data
        self._pos = 4
        self._low = 0
        self._range = _MASK32
        self._code = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) & _MASK32
        self._scaled = 0

    def get_freq(self, total: int) -> int:
        self._scaled = self._range // total
        if self._scaled == 0:
            raise SamMaskDecodeError("Mask payload has invalid range coding state.")
        val = ((self._code - self._low) & _MASK32) // self._scaled
        return total - 1 if val >= total else val

    def decode(self, cumulative: int, frequency: int) -> None:
        self._low = (self._low + self._scaled * cumulative) & _MASK32
        self._range = (self._scaled * frequency) & _MASK32
        while ((self._low ^ ((self._low + self._range) & _MASK32)) < _TOP) or (self._range < _BOTTOM):
            if self._range < _BOTTOM and ((self._low ^ ((self._low + self._range) & _MASK32)) >= _TOP):
                self._range = ((-self._low) & _MASK32) & (_BOTTOM - 1)
            if self._pos >= len(self._data):
                raise SamMaskDecodeError("Mask payload ended before range decoding completed.")
            b = self._data[self._pos]
            self._pos += 1
            self._code = ((self._code << 8) | b) & _MASK32
            self._low = (self._low << 8) & _MASK32
            self._range = (self._range << 8) & _MASK32


def _paeth(left: int, up: int, ul: int) -> int:
    est = left + up - ul
    dl = abs(est - left)
    du = abs(est - up)
    dul = abs(est - ul)
    if dl <= du and dl <= dul:
        return left
    return up if du <= dul else ul


def _predict_byte(out: bytearray, offset: int, x: int, y: int, mode: int, width: int) -> int:
    if mode < 0 or mode >= 5:
        raise SamMaskDecodeError("Lossless mask payload uses an invalid predictor mode.")
    left = out[offset - 1] if x > 0 else 0
    up = out[offset - width] if y > 0 else 0
    if mode == 1:
        return up
    if mode == 2:
        return left
    if mode == 3:
        return (left + up) >> 1
    ul = out[offset - width - 1] if (x > 0 and y > 0) else 0
    if mode == 0:
        return _paeth(left, up, ul)
    if ul >= max(left, up):
        return min(left, up)
    if ul <= min(left, up):
        return max(left, up)
    return left + up - ul


def _decode_lossless_raster(payload: str, width: int, height: int) -> np.ndarray:
    packed = unpack_base85(payload[1:])
    if len(packed) < 5:
        raise SamMaskDecodeError("Lossless mask payload is truncated.")
    selector = packed[0]
    dec = _RangeDecoder(packed[1:])
    length = width * height
    out = bytearray(length)
    residuals = bytearray(length)
    zero_counts = [1] * 32
    order_one = [1] * (256 * 256)
    order_one_totals = [256] * 256
    order_zero = [2] * 256
    order_zero_total = 512
    order_two: Dict[int, List[int]] = {}
    prev = 0

    for offset in range(length):
        x = offset % width
        y = offset // width
        c_left = (1 if residuals[offset - 1] == 0 else 0) if x > 0 else 1
        c_up = (1 if residuals[offset - width] == 0 else 0) if y > 0 else 1
        c_ul = (1 if residuals[offset - width - 1] == 0 else 0) if (x > 0 and y > 0) else 1
        c_ur = (1 if residuals[offset - width + 1] == 0 else 0) if (y > 0 and x < width - 1) else 1
        z_off = (c_left | (c_up << 1) | (c_ul << 2) | (c_ur << 3)) << 1
        z0 = zero_counts[z_off]
        z1 = zero_counts[z_off + 1]
        zf = dec.get_freq(z0 + z1)
        bit = 0 if zf < z0 else 1
        dec.decode(0 if bit == 0 else z0, z0 if bit == 0 else z1)
        zero_counts[z_off + bit] += 32
        if zero_counts[z_off] + zero_counts[z_off + 1] >= 16384:
            zero_counts[z_off] = (zero_counts[z_off] >> 1) or 1
            zero_counts[z_off + 1] = (zero_counts[z_off + 1] >> 1) or 1

        sym = 0
        if bit == 1:
            above = residuals[offset - width] if offset >= width else 0
            key = (prev << 8) | above
            sec = order_two.get(key)
            if sec is None:
                sec = [0] * 257
                order_two[key] = sec
            f_off = prev << 8
            excl0 = sec[0] + order_one[f_off] + order_zero[0]
            total = sec[256] + order_one_totals[prev] + order_zero_total - excl0
            target = dec.get_freq(total)
            cum = 0
            sym = 1
            freq = sec[1] + order_one[f_off + 1] + order_zero[1]
            while cum + freq <= target:
                cum += freq
                sym += 1
                if sym >= 256:
                    raise SamMaskDecodeError("Lossless mask payload symbol overflow.")
                freq = sec[sym] + order_one[f_off + sym] + order_zero[sym]
            dec.decode(cum, freq)
            sec[sym] += 616
            sec[256] += 616
            if sec[256] >= 50176:
                tot = 0
                for v in range(256):
                    sec[v] >>= 1
                    tot += sec[v]
                sec[256] = tot
            order_one[f_off + sym] += 56
            order_one_totals[prev] += 56
            if order_one_totals[prev] >= 8192:
                tot = 0
                for v in range(256):
                    sc = (order_one[f_off + v] >> 1) or 1
                    order_one[f_off + v] = sc
                    tot += sc
                order_one_totals[prev] = tot
            order_zero[sym] += 32
            order_zero_total += 32
            if order_zero_total >= 4096:
                tot = 0
                for v in range(256):
                    order_zero[v] >>= 1
                    tot += order_zero[v]
                order_zero_total = tot

        residuals[offset] = sym
        delta = -((sym + 1) >> 1) if (sym & 1) else (sym >> 1)
        pred = _predict_byte(out, offset, x, y, selector, width)
        out[offset] = (pred + delta) & 0xFF
        prev = sym

    arr = np.frombuffer(out, dtype=np.uint8).reshape((height, width))
    return (arr >= 129).astype(np.uint8)


def _decode_one_bit_raster(payload: str, width: int, height: int) -> np.ndarray:
    dec = _RangeDecoder(unpack_base85(payload[1:]))
    counts = [1] * (_CONTEXT_COUNT * 2)
    padded_width = width + 2 * _PADDING
    padded = bytearray(padded_width * (height + _PADDING))
    output = bytearray(width * height)
    for y in range(height):
        row = (y + _PADDING) * padded_width + _PADDING
        for x in range(width):
            pos = row + x
            prior = pos - padded_width
            earlier = pos - 2 * padded_width
            ctx = (
                padded[pos - 1]
                | (padded[pos - 2] << 1)
                | (padded[prior - 2] << 2)
                | (padded[prior - 1] << 3)
                | (padded[prior] << 4)
                | (padded[prior + 1] << 5)
                | (padded[prior + 2] << 6)
                | (padded[earlier - 2] << 7)
                | (padded[earlier - 1] << 8)
                | (padded[earlier] << 9)
                | (padded[earlier + 1] << 10)
                | (padded[earlier + 2] << 11)
            )
            off = ctx << 1
            z0 = counts[off]
            z1 = counts[off + 1]
            val = dec.get_freq(z0 + z1)
            bit = 0 if val < z0 else 1
            if bit == 0:
                dec.decode(0, z0)
            else:
                dec.decode(z0, z1)
            padded[pos] = bit
            output[y * width + x] = bit
            counts[off + bit] += _INCREMENT
            if counts[off] + counts[off + 1] >= _COUNT_LIMIT:
                counts[off] = (counts[off] >> 1) or 1
                counts[off + 1] = (counts[off + 1] >> 1) or 1
    return np.frombuffer(output, dtype=np.uint8).reshape((height, width)).copy()


def decode_mask_to_raster(payload: str, width: int, height: int) -> np.ndarray:
    if width <= 0 or height <= 0 or width * height > 24_000_000:
        raise SamMaskDecodeError("Invalid SAM mask dimensions.")
    if payload.startswith("~"):
        return _decode_lossless_raster(payload, width, height)
    if payload.startswith("!"):
        return _decode_one_bit_raster(payload, width, height)
    raise SamMaskDecodeError("Unsupported SAM mask encoding prefix.")


def _parse_kv_fields(body: Optional[str]) -> Dict[str, str]:
    result: Dict[str, str] = {}
    if not body:
        return result
    for part in body.split(";"):
        field = part.strip()
        if not field or "=" not in field:
            continue
        k, v = field.split("=", 1)
        result[k.strip()] = v.strip()
    return result


def parse_sam_response_text(text: str, fallback_width: int, fallback_height: int) -> List[ParsedSamCandidate]:
    """Parse SAM 3.1 text output into full-frame binary mask candidates."""
    candidates: List[ParsedSamCandidate] = []
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        m_header = _FRAME_HEADER_RE.match(line)
        if not m_header:
            continue
        records_body = m_header.group(3)
        pos = 0
        while pos < len(records_body):
            m_rec = _RECORD_START_RE.match(records_body, pos)
            if not m_rec:
                break
            object_id = int(m_rec.group(1))
            pos = m_rec.end()
            tokens: List[Tuple[str, Optional[str]]] = []
            while pos < len(records_body):
                m_tok = _TOKEN_RE.match(records_body, pos)
                if not m_tok:
                    break
                tokens.append((m_tok.group(1), m_tok.group(2)))
                pos = m_tok.end()

            box_tokens = [b for name, b in tokens if name == "box"]
            mask_tokens = [b for name, b in tokens if name == "mask"]
            if len(box_tokens) != 1 or len(mask_tokens) != 1:
                continue

            box_fields = _parse_kv_fields(box_tokens[0])
            mask_fields = _parse_kv_fields(mask_tokens[0])
            try:
                x1 = int(box_fields["x1"])
                y1 = int(box_fields["y1"])
                x2 = int(box_fields["x2"])
                y2 = int(box_fields["y2"])
                w = int(box_fields.get("w", fallback_width))
                h = int(box_fields.get("h", fallback_height))
            except (KeyError, ValueError):
                continue

            m_data = _MASK_DATA_RE.match(mask_fields.get("data", ""))
            if not m_data:
                continue
            mh = int(m_data.group(1))
            mw = int(m_data.group(2))
            mpayload = m_data.group(3)
            right = x2 + 1
            bottom = y2 + 1
            if x1 < 0 or y1 < 0 or right > w or bottom > h:
                continue
            if mw != (right - x1) or mh != (bottom - y1):
                continue

            sub_raster = decode_mask_to_raster(mpayload, mw, mh)
            full_mask = np.zeros((h, w), dtype=np.uint8)
            full_mask[y1:bottom, x1:right] = sub_raster

            conf_raw = mask_fields.get("c") or box_fields.get("c")
            confidence: Optional[float] = None
            if conf_raw is not None:
                try:
                    c_val = float(conf_raw)
                    if 0.0 <= c_val <= 1.0:
                        confidence = c_val
                except ValueError:
                    pass

            if full_mask.shape != (fallback_height, fallback_width):
                import cv2

                full_mask = cv2.resize(
                    full_mask,
                    (fallback_width, fallback_height),
                    interpolation=cv2.INTER_NEAREST,
                )

            candidates.append(
                ParsedSamCandidate(
                    object_id=object_id,
                    box_xyxy=(x1, y1, right, bottom),
                    source_width=fallback_width,
                    source_height=fallback_height,
                    mask=full_mask,
                    confidence=confidence,
                )
            )
    return candidates


def build_sam_object_prompt(
    width: int,
    height: int,
    *,
    box: Optional[Tuple[int, int, int, int]] = None,
    points: Optional[List[Dict[str, int | str]]] = None,
    object_id: int = 0,
) -> str:
    """Build a SAM 3.1 spatial object prompt token string for a single frame."""
    if width <= 0 or height <= 0:
        raise ValueError("Image width and height must be positive integers.")
    view = f"w={width};h={height}"
    tokens: List[str] = []
    if box is not None:
        left, top, right, bottom = [int(v) for v in box]
        left = max(0, min(width - 1, left))
        top = max(0, min(height - 1, top))
        right = max(left + 1, min(width, right))
        bottom = max(top + 1, min(height, bottom))
        tokens.append(f"<|box;x1={left};y1={top};x2={right - 1};y2={bottom - 1};{view}|>")
    if points:
        for pt in points:
            px = max(0, min(width - 1, int(pt["x"])))
            py = max(0, min(height - 1, int(pt["y"])))
            label = str(pt.get("label", "positive"))
            prefix = "-" if label == "negative" else ""
            tokens.append(f"{prefix}<|point;x={px};y={py};{view}|>")
    if not tokens:
        raise ValueError("At least one box or point is required to build a spatial prompt.")
    return f"<0f>{object_id}{''.join(tokens)}"


MAX_SAM_SPATIAL_OBJECTS = 16  # Meta SAM 3.1 limit for box/point prompts in one request


def build_sam_multi_object_prompt(width: int, height: int, objects: List[Dict]) -> str:
    """Spatial prompt with one record per object: `<0f>0<|box…|><|point…|>,1<|box…|>…`.

    Each object is {"box": (left, top, right_exclusive, bottom_exclusive), "points": [...]}.
    Spatial prompts are never mixed with a noun phrase (a separate SAM 3.1 prompt mode).
    """
    if not objects or len(objects) > MAX_SAM_SPATIAL_OBJECTS:
        raise ValueError(f"A spatial prompt needs between 1 and {MAX_SAM_SPATIAL_OBJECTS} objects.")
    records = [
        build_sam_object_prompt(width, height, box=obj.get("box"), points=obj.get("points"), object_id=index)[len("<0f>"):]
        for index, obj in enumerate(objects)
    ]
    return "<0f>" + ",".join(records)
