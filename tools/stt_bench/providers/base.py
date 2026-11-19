"""Shared adapter interface, lesson context and HTTP helpers (stdlib only)."""
import json
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Lesson:
    """All items of one template, so prompts and closed sets cover the whole lesson, not just the asked item."""
    template_id: str
    items: dict = field(default_factory=dict)  # item_id -> {"display", "expected", "accepted_variants"}

    def answers(self):
        """Every accepted answer string, letters first, without duplicates."""
        out = [a for it in self.items.values() for a in it["expected"]]
        out += [a for it in self.items.values() for a in it["accepted_variants"]]
        return list(dict.fromkeys(out))

    def choices(self):
        return [it["display"] for it in self.items.values()]

    def described_choices(self):
        """Closed-set option list for prompts: 'अ (also: अ अननसाचा / अननस)'."""
        return "\n".join(f"- {it['display']} (also counts: {' / '.join(it['accepted_variants'])})"
                         for it in self.items.values())

    def candidates(self):
        """Every accepted answer of every item, in lesson order, each text once."""
        out = {}
        for iid, it in self.items.items():
            for text in it["expected"] + it["accepted_variants"]:
                out.setdefault(text, Candidate(iid, it["display"], text))
        return list(out.values())


@dataclass(frozen=True)
class Candidate:
    item_id: str
    display: str  # the item's letter: what a closed-set Output reports
    text: str     # one accepted answer: the letter, letter + picture word, or the word alone


@dataclass
class Output:
    text: str               # transcript, or the closed-set choice
    closed: bool = False    # True: text is a choice (a lesson letter, "other" or "nothing")
    cost: float | None = None  # in the provider's pricing currency; None: bench prices it by duration
    note: str = ""          # extra detail for the CSV (e.g. Whisper's free decode in closed mode)
    transcript: str = ""    # closed scorers: their free decode, if any
    scores: dict | None = None  # closed scorers: candidate text -> score (higher is more likely)
    latency_ms: int | None = None  # set when the work ran elsewhere (e.g. on the phone); else bench times run()
    unsure: bool = False    # closed scorers: the model is unsure what it heard (a wrong verdict becomes unclear)


class Provider:
    name = ""
    audio = "wav16k"   # "wav16k": 16 kHz mono PCM WAV; "original": the clip as exported
    external = True    # sends audio to a third party
    pricing = ""       # key into pricing.PRICES (defaults to name)

    def missing(self):
        """None when the provider can run, else the reason it is skipped."""
        return None

    def prepare(self):
        """Load models before timing starts."""

    def run(self, path: Path, clip: dict, lesson: Lesson) -> Output:
        raise NotImplementedError


@dataclass
class Judgement:
    choice: "Candidate | str"  # a Candidate, evaluator.OTHER or evaluator.NOTHING
    scores: dict = field(default_factory=dict)  # candidate text -> score, higher is more likely
    transcript: str = ""       # free decode, if the scorer has one
    note: str = ""
    unsure: bool = False       # the model is unsure what it heard: never tell the child "wrong"


class ClosedScorer(Provider):
    """Closed-set judge: hears the clip, knows every candidate answer of the lesson, and picks one,
    "other" (something else was said) or "nothing" (no speech). Subclasses implement judge()."""

    def judge(self, path: Path, item: dict, candidates: list[Candidate]) -> Judgement:
        """item is the asked item, for diagnostics only: the choice must not lean towards it (README)."""
        raise NotImplementedError

    def run(self, path, clip, lesson):
        j = self.judge(path, clip, lesson.candidates())
        choice = j.choice.display if isinstance(j.choice, Candidate) else j.choice
        return Output(choice, closed=True, note=j.note, transcript=j.transcript, scores=j.scores, unsure=j.unsure)


def _open(req, timeout, retries=4):
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code not in (429, 500, 502, 503) or attempt == retries:
                body = e.read()[:300].decode("utf-8", "replace")
                raise RuntimeError(f"HTTP {e.code}: {body}") from None
            time.sleep(3 * (attempt + 1))


def post_json(url, body, headers, timeout=60):
    req = urllib.request.Request(url, data=json.dumps(body, ensure_ascii=False).encode(), method="POST",
                                 headers={"Content-Type": "application/json", **headers})
    return _open(req, timeout)


MIME = {".m4a": "audio/mp4", ".mp4": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav",
        ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".flac": "audio/flac", ".webm": "audio/webm"}


def post_multipart(url, fields, path: Path, headers, timeout=60):
    b = uuid.uuid4().hex
    body = b"".join(f"--{b}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
                    for k, v in fields.items())
    mime = MIME.get(path.suffix.lower(), "application/octet-stream")
    body += (f"--{b}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\n"
             f"Content-Type: {mime}\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{b}--\r\n".encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={b}", **headers})
    return _open(req, timeout)
