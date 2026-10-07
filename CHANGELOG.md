# Changelog

## 0.1.0

First public release of the native-text pipeline.

- Interactive Markdown reader with browser-free MathJax SVG/resvg formula images.
- Embeddable `view-latex-md-math` renderer, Markdown layout and Kitty graphics API.
- True inline/display math, transparent glyph images and baseline-aware line groups.
- Unicode-aware native text wrapping, source mode, edit/reload, resize and formula zoom.
- Independent TeX state; bounded SVG/PNG caches with concurrent request deduplication.
- Size-independent TeX cache: changing font size/color only rerasterizes the SVG.
- Shared textures, independent image placements, viewport clipping and serialized output.
- Zellij 0.45.1 padded crop path with isolated real-session RGBA verification.
- Browser-free vector math PNG export.

Known limits: row-based scrolling; estimated terminal text baseline; no tmux image passthrough or iTerm2 image backend; basic tables and image labels; no cross-formula macro scope or background rendering workers.
