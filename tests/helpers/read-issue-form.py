"""Read the form's supported YAML subset; reject unsupported syntax."""

import json
import pathlib
import re
import sys


def scalar(value):
    if value in ("true", "false") or value.startswith(('"', '[')):
        return json.loads(value)
    assert value and value[0] not in "'&*!{>|", "Unsupported scalar syntax"
    assert " #" not in value and ": " not in value, "Use JSON quoting for scalars"
    return value


form, current, section, literal = {}, None, None, False
in_body = False
for number, line in enumerate(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8").splitlines(), 1):
    if literal and (not line.strip() or line.startswith("        ")):
        current["attributes"]["value"] += line[8:] + "\n"
        continue
    literal = False
    if not line.strip() or line.lstrip().startswith("#"):
        continue
    assert "\t" not in line, f"Use spaces at line {number}"
    element = re.fullmatch(r"  - type: ([a-z]+)", line)
    if element:
        assert in_body and isinstance(form.get("body"), list), "Expected body before elements"
        current, section = {"type": element[1]}, None
        form["body"].append(current)
        continue
    option = re.fullmatch(r"        - (.+)", line)
    if option:
        assert section == "attributes" and isinstance(current[section].get("options"), list)
        current[section]["options"].append(scalar(option[1]))
        continue
    field = re.fullmatch(r"( *)([a-z][a-z-]*):(?: (.+))?", line)
    assert field, f"Unsupported form syntax at line {number}"
    indent, key, value = len(field[1]), field[2], field[3]
    if indent == 0:
        target = form
        in_body = key == "body"
        current, section = None, None
    elif indent == 4 and current is not None:
        target = current
        section = None
    elif indent == 6 and section is not None:
        target = current[section]
    else:
        raise AssertionError(f"Unexpected indentation at line {number}")
    assert key not in target, f"Duplicate key at line {number}: {key}"
    if value is None:
        if (indent, key) == (0, "body") or (indent, section, key) == (6, "attributes", "options"):
            target[key] = []
        else:
            assert indent == 4 and key in ("attributes", "validations")
            target[key], section = {}, key
    elif value == "|":
        assert (indent, section, key) == (6, "attributes", "value")
        target[key], literal = "", True
    else:
        target[key] = scalar(value)

print(json.dumps(form, ensure_ascii=False))
