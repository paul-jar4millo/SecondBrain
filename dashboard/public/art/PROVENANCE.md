# Visual asset provenance

The scene and characters are in `public/models/sala`. Their editable sources
are `dashboard/ops/room-refuge.py` and `room-models.py`; the scene also keeps
its Blender file. All of them were made for this project.

Portraits in `public/portraits` are rendered from the models by
`dashboard/ops/render-agent-portraits.mjs`. HUD glyphs are geometry in
`src/components/HudGlyph.tsx`.

Visual references guide composition but grant no right to redistribute
third-party images. The reference bank is optional (`SB_REFERENCE_BANK`); the
demo only uses first-party assets (`src/features/room/demo-references.ts`).
Fonts in `public/fonts` keep their OFL licenses.

Visual direction: [DESIGN](../../../DESIGN.md).
