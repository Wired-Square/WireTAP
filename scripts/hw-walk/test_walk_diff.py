import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("walk_diff", os.path.join(HERE, "walk-diff"))
_spec = importlib.util.spec_from_loader("walk_diff", _loader)
walk_diff = importlib.util.module_from_spec(_spec)
_loader.exec_module(walk_diff)


def cangen_log(n, start_us=1_000_000, gap_us=1000, fd=False, suffix=" T"):
    """What `cangen -I i -L i -D i` logs on the reference: incrementing id, length and data."""
    lengths = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64] if fd else list(range(9))
    lines = []
    for i in range(n):
        length = lengths[i % len(lengths)]
        counter = (i + 1).to_bytes(8, "little")
        data = (counter * 8)[:length]
        ts = start_us + i * gap_us
        sep = "##1" if fd else "#"
        lines.append(f"({ts // 1_000_000}.{ts % 1_000_000:06d}) can0 {i % 0x800:03X}{sep}{data.hex().upper()}{suffix}")
    return lines


def frame_json(line, start_us=5_000_000_000, direction=None):
    """The MCP `get_capture_frames` shape of one candump line, received by WireTAP."""
    (frame,) = walk_diff.parse_candump(line)
    msg = {
        "protocol": "can",
        "timestamp_us": frame.ts_us + start_us,
        "frame_id": frame.frame_id,
        "bus": 0,
        "dlc": len(frame.data),
        "bytes": list(frame.data),
        "is_extended": frame.extended,
        "is_fd": bool(frame.fd),
    }
    if direction:
        msg["direction"] = direction
    return msg


class WalkDiff(unittest.TestCase):
    def run_diff(self, ref_lines, wt, *args):
        with tempfile.TemporaryDirectory() as tmp:
            ref_path = os.path.join(tmp, "walk.log")
            wt_path = os.path.join(tmp, "capture.json")
            with open(ref_path, "w") as fh:
                fh.write("\n".join(ref_lines) + "\n")
            with open(wt_path, "w") as fh:
                json.dump({"total": len(wt), "offset": 0, "frames": wt}, fh)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = walk_diff.main([ref_path, wt_path, "--json", *args])
        return code, json.loads(out.getvalue())

    def assert_only(self, report, **expected):
        counts = {
            "drops": report["drops"],
            "duplicates": report["duplicates"],
            "reordered": report["reordered"],
            "unexpected": report["unexpected"],
            "direction_mismatches": report["direction_mismatches"],
            **report["mismatches"],
        }
        self.assertEqual({k: v for k, v in counts.items() if v}, expected)

    def test_a_perfect_match_passes(self):
        ref = cangen_log(100)
        code, report = self.run_diff(ref, [frame_json(line) for line in ref])
        self.assertEqual(code, 0)
        self.assertEqual(report["mode"], "sequence")
        self.assertEqual(report["matched"], 100)
        self.assert_only(report)
        self.assertEqual(report["gap_error_us"]["median"], 0)

    def test_a_drop_is_counted_and_fails(self):
        ref = cangen_log(50)
        wt = [frame_json(line) for i, line in enumerate(ref) if i != 20]
        code, report = self.run_diff(ref, wt)
        self.assertEqual(code, 1)
        self.assert_only(report, drops=1)
        self.assertEqual(report["examples"]["drops"], ["014#1500"])

    def test_a_duplicate_is_counted(self):
        ref = cangen_log(50)
        wt = [frame_json(line) for line in ref]
        wt.insert(21, dict(wt[20]))
        code, report = self.run_diff(ref, wt)
        self.assertEqual(code, 1)
        self.assert_only(report, duplicates=1)

    def test_a_swapped_pair_is_one_reorder(self):
        ref = cangen_log(50)
        wt = [frame_json(line) for line in ref]
        wt[20], wt[21] = wt[21], wt[20]
        code, report = self.run_diff(ref, wt)
        self.assertEqual(code, 1)
        self.assert_only(report, reordered=1)

    def test_an_fd_frame_cut_to_eight_bytes_is_a_length_mismatch(self):
        ref = cangen_log(32, fd=True)
        wt = [frame_json(line) for line in ref]
        wt[13]["bytes"] = wt[13]["bytes"][:8]
        code, report = self.run_diff(ref, wt)
        self.assertEqual(code, 1)
        self.assert_only(report, length=1)

    def test_an_fd_frame_that_lost_its_fd_flag_is_caught(self):
        ref = cangen_log(32, fd=True)
        wt = [frame_json(line) for line in ref]
        wt[3]["is_fd"] = False
        _, report = self.run_diff(ref, wt)
        self.assert_only(report, fd=1)

    def test_an_rtr_arrives_as_an_empty_frame(self):
        ref = ["(1.000000) can0 123#R T", "(1.001000) can0 12345678#R4 T"]
        wt = [
            {"protocol": "can", "timestamp_us": 9_000_000, "frame_id": 0x123, "bus": 0,
             "dlc": 0, "bytes": [], "is_extended": False, "is_fd": False},
            {"protocol": "can", "timestamp_us": 9_001_000, "frame_id": 0x12345678, "bus": 0,
             "dlc": 0, "bytes": [], "is_extended": True, "is_fd": False},
        ]
        code, report = self.run_diff(ref, wt)
        self.assertEqual(code, 0)
        self.assertEqual(report["mode"], "multiset")
        self.assert_only(report)

    def test_an_rtr_that_arrives_with_data_is_a_length_mismatch(self):
        ref = ["(1.000000) can0 123#R T"]
        wt = [{"protocol": "can", "timestamp_us": 1, "frame_id": 0x123, "bus": 0, "dlc": 2,
               "bytes": [0, 0], "is_extended": False, "is_fd": False}]
        _, report = self.run_diff(ref, wt)
        self.assert_only(report, length=1)

    def test_a_direction_flip_is_caught(self):
        # The reference sent these (T), so WireTAP must have received them.
        ref = cangen_log(10)
        wt = [frame_json(line) for line in ref]
        wt[4]["direction"] = "tx"
        code, report = self.run_diff(ref, wt)
        self.assertEqual(code, 1)
        self.assert_only(report, direction_mismatches=1)

    def test_wiretaps_own_transmits_are_received_at_the_reference(self):
        ref = cangen_log(10, suffix=" R")
        code, report = self.run_diff(ref, [frame_json(line, direction="tx") for line in ref])
        self.assertEqual(code, 0)
        _, same = self.run_diff(ref, [frame_json(line, direction="tx") for line in ref], "--direction", "same")
        self.assert_only(same, direction_mismatches=10)

    def test_gap_error_ignores_the_clock_offset(self):
        ref = cangen_log(5, gap_us=1000)
        wt = [frame_json(line) for line in ref]
        wt[3]["timestamp_us"] += 400
        _, report = self.run_diff(ref, wt)
        self.assertEqual(report["gap_error_us"], {"count": 4, "median": 200.0, "p99": 400})

    def test_a_frame_the_reference_never_saw_is_unexpected(self):
        ref = cangen_log(10)
        wt = [frame_json(line) for line in ref]
        wt.append({"protocol": "can", "timestamp_us": 1, "frame_id": 0x7FF, "bus": 0, "dlc": 1,
                   "bytes": [1], "is_extended": False, "is_fd": False})
        _, report = self.run_diff(ref, wt)
        self.assert_only(report, unexpected=1)

    def test_candump_parses_fd_flags_and_extended_ids(self):
        (plain, fd, ext) = walk_diff.parse_candump(
            "(1.5) can0 123#DEAD R\n(2.000001) can1 456##3" + "00" * 12 + "\n(3.0) can0 00000123#"
        )
        self.assertEqual((plain.ts_us, plain.direction, plain.fd), (1_500_000, "rx", False))
        self.assertEqual((fd.fd, fd.brs, len(fd.data), fd.bus), (True, True, 12, 1))
        self.assertTrue(ext.extended)
        self.assertIsNone(ext.direction)

    def test_wiretaps_candump_export_leaves_fd_unknown(self):
        ref = cangen_log(20, fd=True)
        export = [line.replace("##1", "#").removesuffix(" T") for line in ref]
        with tempfile.TemporaryDirectory() as tmp:
            ref_path, wt_path = os.path.join(tmp, "walk.log"), os.path.join(tmp, "export.log")
            for path, lines in ((ref_path, ref), (wt_path, export)):
                with open(path, "w") as fh:
                    fh.write("\n".join(lines))
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(walk_diff.main([ref_path, wt_path]), 0)

    def test_bus_filter_keeps_one_bus(self):
        ref = cangen_log(10)
        wt = [frame_json(line) for line in ref]
        for f in wt:
            f["bus"] = 1
        _, on_zero = self.run_diff(ref, wt, "--bus", "0")
        self.assert_only(on_zero, drops=10)
        code, _ = self.run_diff(ref, wt, "--bus", "1")
        self.assertEqual(code, 0)

    def test_wiretap_can_cli_dump_lines_parse(self):
        """Lines as `wiretap-can-cli dump --own` prints them, pinned by its candump tests."""
        lines = [
            "(1727000000.000042) gsusb-205933B831335010-1 123#DEADBEEF R",
            "(1727000000.000043) gsusb-205933B831335010-1 01234567#0102 T",
            "(1727000000.000044) gsusb-205933B831335010-1 123#R5 R",
            "(1727000000.000045) gsusb-205933B831335010-1 123##1A5A5A5A5A5A5A5A5A5A5A5A5 R",
            "(1727000000.000046) gsusb-205933B831335010-1 123##0AA R",
            "(1727000000.000047) gsusb-205933B831335010-1 007# T",
        ]
        frames = walk_diff.parse_candump("\n".join(lines))
        self.assertEqual(
            [(f.frame_id, f.extended, f.fd, f.brs, f.rtr, len(f.data), f.direction, f.bus) for f in frames],
            [
                (0x123, False, False, False, False, 4, "rx", 1),
                (0x1234567, True, False, False, False, 2, "tx", 1),
                (0x123, False, False, False, True, 0, "rx", 1),
                (0x123, False, True, True, False, 12, "rx", 1),
                (0x123, False, True, False, False, 1, "rx", 1),
                (0x7, False, False, False, False, 0, "tx", 1),
            ],
        )
        self.assertEqual(frames[0].ts_us, 1_727_000_000_000_042)

    def test_wiretap_can_cli_gen_is_scored_as_a_sequence(self):
        """`gen -I i -L i -D i`'s frames, as can-utils' cangen sends them."""
        lines = []
        for i in range(100):
            length = max(i % 9, 1)
            data = i.to_bytes(8, "little")[:length].hex().upper()
            lines.append(f"(1727000000.{i * 1000:06d}) socketcan-can0 {i:03X}#{data} T")
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "gen.log")
            with open(path, "w") as fh:
                fh.write("\n".join(lines))
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                code = walk_diff.main([path, path, "--json", "--direction", "same"])
        report = json.loads(out.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual(report["mode"], "sequence")
        self.assertEqual(report["matched"], 100)


if __name__ == "__main__":
    unittest.main()
