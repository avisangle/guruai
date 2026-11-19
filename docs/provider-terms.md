# Speech provider terms for a children's app

Read 2026-11-15 from the providers' own pages. GuruAI's two uses: (1) tutor voice lines generated ahead of time and bundled in the app; (2) children's spoken answers sent from our backend to speech-to-text at runtime. Not legal advice; open questions at the end.

| Provider / model | Bundled TTS | Runtime STT of child audio | Deciding source |
|---|---|---|---|
| Gemini API (AI Studio key) | Unclear for pre-generated audio; live use barred | Barred | aistudio.google.com/docs/terms, "Age Requirements" |
| Google Cloud Gemini-TTS | Barred (Generative AI Service) | n/a | cloud.google.com/terms/service-terms s.20(d) |
| Google Cloud TTS Standard / WaveNet / Neural2 | Allowed (Pre-Trained API, not Generative AI) | n/a | cloud.google.com/terms/services |
| Google Cloud TTS Chirp 3 HD | Unclear (generative catch-all) | n/a | s.20 catch-all + Chirp 3 HD docs |
| Google Cloud STT `long` / `short` | n/a | Allowed; audio not logged by default; no training without permission | cloud.google.com/terms/services; s.18; data-logging docs |
| Google Cloud STT Chirp 3 (Chirp, Chirp 2 unchecked) | n/a | Unclear (generative catch-all) | Chirp 3 docs + catch-all |
| ElevenLabs | Barred unless approved in writing | Barred unless approved in writing; zero retention is enterprise-only | elevenlabs.io/use-policy, "Use by and for Minors" |
| Sarvam (Bulbul TTS, STT) | Allowed with verifiable parental consent | Allowed with verifiable parental consent; set workspace retention to 0 days | sarvam.ai/terms-of-service s.2.2, 8.4, 10.5(d) |
| Azure AI Speech | Probably allowed (Product Terms not fully read) | Probably allowed; real-time audio not retained | learn.microsoft.com AI Code of Conduct; Speech data-privacy doc |

Key quotes:
- Gemini API: "You also will not use the Services as part of a website, application, or other service ... that is directed towards or is likely to be accessed by individuals under the age of 18."
- ElevenLabs: "Apps, products, or experiences directed at individuals under 18 are prohibited unless we have assessed and approved them in writing."
- Sarvam s.2.2: minors may use the services "only where verifiable consent has been provided by your parent or lawful guardian"; s.10.5(d): our end-user terms may not be less restrictive than Sarvam's.

## Open questions (need a lawyer or written confirmation)

1. Google: is offline pre-generated Gemini-TTS / Chirp 3 HD audio "use ... as part of" a child-directed app; are Chirp 3 STT/TTS "generative AI features"?
2. Sarvam: signed DPA; which of its three conflicting training clauses governs API data; 0-day retention covering STT and TTS; whether our in-app parental consent meets its "verifiable consent" bar.
3. ElevenLabs: written approval, or do not use.
4. Azure: Product Terms age clauses; Marathi region.
5. Ours, whichever provider: verifiable parental consent for children's voice data under the DPDP Act 2023, and the Play Data safety disclosure of a third-party speech processor.
