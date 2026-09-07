from pathlib import Path

path = Path(".github/debug-implement-native-web-search.py")
text = path.read_text()
old = '''def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    old = d(old)
    new = d(new)
    if old not in text:
        raise RuntimeError(f"marker not found in {path}: {old[:120]!r}")
    p.write_text(text.replace(old, new, 1))
'''
new = '''def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    old = d(old)
    new = d(new)
    candidates = [(old, new)]
    for indent in (2, 4, 6, 8, 10, 12):
        prefix = " " * indent
        indented_old = "\\n".join(prefix + line if line else line for line in old.split("\\n"))
        indented_new = "\\n".join(prefix + line if line else line for line in new.split("\\n"))
        candidates.append((indented_old, indented_new))
    for candidate_old, candidate_new in candidates:
        if candidate_old in text:
            p.write_text(text.replace(candidate_old, candidate_new, 1))
            return
    raise RuntimeError(f"marker not found in {path}: {old[:120]!r}")
'''
if old not in text:
    raise RuntimeError("replace_once helper marker not found")
path.write_text(text.replace(old, new, 1))
