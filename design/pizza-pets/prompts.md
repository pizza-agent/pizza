# Generation prompts

Mode: built-in imagegen. Date: 2026-10-26.

## Pizza family v1

```text
Use case: stylized-concept.
Asset type: an original Pizza brand desktop-pet character design presentation, landscape 3:2, very polished, clean white background.
Design four ORIGINAL adorable characters for an AI app named Pizza. Shared design DNA: one simple chunky floating silhouette, just two short vertical white pill-shaped eyes, soft rounded edges, minimal facial details, smooth satin-vinyl/clay material, beautifully controlled soft 3D volume and tiny highlights. Compact enough to read at 48px. The aesthetic is friendly, modern, sculptural, like a collectible tiny desk toy, with the graphic simplicity of the colorful minimal mascots the user showed. No detailed fur, no robots, no screens, no human limbs, no clothing.
Four Pizza-family food characters:
01 PIP — the hero/default: a thick rounded triangular pizza slice, rounded tip pointing down, a puffy golden-brown crust along the top, a vivid warm orange cheese face, two short white vertical eyes; exactly ONE small muted-red pepperoni dot placed near one upper corner, not in the eye area; a tiny green basil accent on the crust. Very simple, charming, slightly asymmetric, coherent single body. Make this clearly the most iconic and immediately recognizable PIZZA silhouette.
02 MOZZ — a small pale golden mozzarella/cheese droplet with a soft curled cheese tuft and a slightly drippy rounded base, two dark espresso pill eyes (dark only for legibility on this cream character).
03 POMO — a squishy coral-red tomato orb, subtle flattened base, tiny dark green three-leaf crown, two white pill eyes.
04 BASI — a plump folded basil-leaf creature, mint-to-emerald green, one pointed folded top and softly rounded lower body, two white pill eyes. No sharp edges.
Composition: a beautifully spaced horizontal character lineup, four separate columns, all floating just above their very subtle soft ground shadows. PIP about 25% larger than others as default. Each character has a 3/4 main view. Beneath each main render, a small front-view miniature around 48px to demonstrate compact readability. Do not crop any character. Huge white breathing room, consistent studio lighting upper left, soft ambient occlusion and soft lower-right shadow. No colored cards or scene props.
Typography: tasteful small charcoal sans-serif title at top left exactly "PIZZA / PETS"; a subtle subtitle exactly "Character direction 01". Under the characters render labels exactly "PIP", "MOZZ", "POMO", "BASI"; small subtitle under PIP exactly "DEFAULT". Keep all text secondary to the art. No other text, no watermarks, no borrowed logos or copyrighted mascots.
The result should feel like a serious brand-mascot design studio's first concept board, not a children's menu or a UI screenshot.
```

## PIP states v1

Reference: `images/pizza-family-v1.png`.

```text
Use case: stylized-concept.
Asset type: character expression and animation-state concept sheet for a Pizza app desktop pet.
Input image 1 is the approved-for-exploration Pizza-family direction board, used as the CHARACTER IDENTITY REFERENCE. Use ONLY the leftmost orange triangular pizza character labeled PIP. Do not include the other three characters.
Create a beautiful landscape 3:2 state sheet with exactly EIGHT equally spaced cells in a clean 4-column by 2-row layout on a white background. All eight cells depict the SAME PIP character, rendered as a polished cute soft 3D mascot. Preserve its chunky rounded downward triangular pizza body, puffy toasted golden crust, one small red pepperoni near the upper-right corner of its face, the little green basil leaf on top, two white pill eyes, orange-cheese palette, proportions, lighting direction, and material. Keep all poses immediately recognizable as the same model. No arms, no legs, no robot details, no hats, no computers. It is an expressive floating sculptural character, not a realistic food photograph; gently simplified satin surfaces.
Eight states, in reading order:
1 IDLE: neutral upright hover, open vertical white eyes, relaxed subtle tilt, very small grounding shadow.
2 THINKING: tilted about 15 degrees, eyes looking upward and slightly asymmetric, a tiny subtle three-dot thought mark above one side.
3 WORKING: lean forward, gently focused narrower white eyes, controlled energy, two small soft motion ticks to indicate concentration; no angry eyebrows and no tools.
4 HAPPY: body slightly lifted and rounded, white eyes curve into two smiling crescents; warm, affectionate but minimal.
5 CELEBRATING: a cheerful midair hop, slight squash-and-stretch, raised crust and excited crescent eyes, three or four tiny warm confetti pieces, higher and softer shadow.
6 SAD: very small gentle droop, lowered eyes, slightly sagging posture, no dramatic tears, no guilt-inducing text.
7 SLEEPY: softly curled/leaning to one side, eyes become short white closed lines, basil leaf relaxed, two very small gray z symbols; calm.
8 EATING: subtly puffy cheeks/body with small white eyes, a tiny golden cheese morsel just in front and one small crumb; tiny minimal mouth only in this state if needed. Do not remove or bite away its main body.
Use consistent base character size (around 190px tall in each cell), consistent 3/4 camera and soft studio illumination. Generous whitespace between cells, no panels, no borders or boxes, no scene background. Shadows must be soft and localized.
Typography: small tasteful dark charcoal sans-serif heading top left exactly "PIP / STATES", secondary line exactly "One character, eight states". At the bottom of each cell, render the following labels exactly, one per cell in order: "待命 · IDLE", "思考 · THINKING", "工作 · WORKING", "开心 · HAPPY", "庆祝 · CELEBRATING", "失落 · SAD", "休息 · SLEEPY", "进食 · EATING". Keep text elegant and smaller than the art. No other characters or text. No watermarks. This should be a premium mascot design studio's coherent character-state board, suitable for choosing the eventual animation direction.
```


## 运行时资产说明（2026-10-27）

默认实时 3D 形象由程序网格、材质和动画实现，以上生成图作为设计参考，不作为模型纹理。`apps/web/src/assets/pets/*-states.png` 为后续生成的四列两行透明状态图，仅在 WebGL 不可用时按需加载作为二维降级素材。`images/implemented-*-3d.png` 和 `images/realtime-3d-demo.mp4` 来自实际代码渲染，并非生成效果图。
## 二维降级状态图提示词

### pip

```text
Use case: stylized-concept / production game sprite atlas.
Input images are CHARACTER IDENTITY REFERENCES, not backgrounds to retain. Reference 1 defines the Pizza family; reference 2 defines expression design only.
Generate a genuinely TRANSPARENT RGBA production sprite atlas containing ONLY PIP, the orange triangular pizza slice at the LEFT of reference 1 and the ONLY character in reference 2. Preserve its plump golden crust, little green basil leaf, single red pepperoni high on the right of its face, and white pill eyes.
Exactly 8 separate poses in a precision 4-column by 2-row regular grid, equal cells, no overlapping cells. Canvas ideally 2048x1024 (2:1). Each cell has generous identical transparent padding, centered character with identical model size and vertical anchor. The character fills about 78% of each cell, including decoration. All eight must use exactly the same recognizable character, camera angle, material, warm upper-left studio lighting and proportions. Rounded smooth realistic clay/food 3D like the approved references. Fine enough to look beautiful at 64px. No backdrop, NO white squares, no checkerboard drawn into the image, no text or labels, no borders, no contact sheet styling. Use transparent empty space around and between characters. No background shadows on white; only the faintest local translucent contact shadow if any. No other characters.
States in exact row-major order:
TOP LEFT cell 1: IDLE, upright relaxed hovering, two open vertical eyes.
TOP cell 2: THINKING, slight 12-degree inquisitive tilt and upward eyes, three tiny thought dots entirely inside the cell.
TOP cell 3: WORKING, small forward lean, focused narrowed eyes and 2 tiny soft motion ticks.
TOP RIGHT cell 4: HAPPY, gently lifted body, two white smiling curved crescent eyes (dark espresso crescents for MOZZ).
BOTTOM LEFT cell 5: CELEBRATING, a little joyful hop, subtle squash/stretch, crescent eyes, 3 tiny warm confetti pieces inside cell; keep model size same.
BOTTOM cell 6: SAD, gentle drooping posture and lowered eyes, no tears.
BOTTOM cell 7: SLEEPY, body leaning about 15 degrees, two closed short eye-lines, tiny subtle z marks inside cell.
BOTTOM RIGHT cell 8: EATING, slightly puffy body/cheeks and a tiny gold morsel with one crumb, minimal tiny mouth if needed.
Important: this is an implementation asset, not a design presentation. NO WORDS ANYWHERE. Exact 4x2 grid on real alpha transparency. Keep edges clean and sharp, with no fuzzy background halo baked into the character.
```

### mozz

```text
Use case: stylized-concept / production game sprite atlas.
Input images are CHARACTER IDENTITY REFERENCES, not backgrounds to retain. Reference 1 defines the Pizza family; reference 2 defines expression design only.
Generate a genuinely TRANSPARENT RGBA production sprite atlas containing ONLY MOZZ, the pale golden cream mozzarella droplet, SECOND character in reference 1. Preserve the curled cheesy tuft, three rounded drippy lobes, espresso-dark pill eyes and smooth creamy soft 3D volume. Do not draw a pizza slice.
Exactly 8 separate poses in a precision 4-column by 2-row regular grid, equal cells, no overlapping cells. Canvas ideally 2048x1024 (2:1). Each cell has generous identical transparent padding, centered character with identical model size and vertical anchor. The character fills about 78% of each cell, including decoration. All eight must use exactly the same recognizable character, camera angle, material, warm upper-left studio lighting and proportions. Rounded smooth realistic clay/food 3D like the approved references. Fine enough to look beautiful at 64px. No backdrop, NO white squares, no checkerboard drawn into the image, no text or labels, no borders, no contact sheet styling. Use transparent empty space around and between characters. No background shadows on white; only the faintest local translucent contact shadow if any. No other characters.
States in exact row-major order:
TOP LEFT cell 1: IDLE, upright relaxed hovering, two open vertical eyes.
TOP cell 2: THINKING, slight 12-degree inquisitive tilt and upward eyes, three tiny thought dots entirely inside the cell.
TOP cell 3: WORKING, small forward lean, focused narrowed eyes and 2 tiny soft motion ticks.
TOP RIGHT cell 4: HAPPY, gently lifted body, two white smiling curved crescent eyes (dark espresso crescents for MOZZ).
BOTTOM LEFT cell 5: CELEBRATING, a little joyful hop, subtle squash/stretch, crescent eyes, 3 tiny warm confetti pieces inside cell; keep model size same.
BOTTOM cell 6: SAD, gentle drooping posture and lowered eyes, no tears.
BOTTOM cell 7: SLEEPY, body leaning about 15 degrees, two closed short eye-lines, tiny subtle z marks inside cell.
BOTTOM RIGHT cell 8: EATING, slightly puffy body/cheeks and a tiny gold morsel with one crumb, minimal tiny mouth if needed.
Important: this is an implementation asset, not a design presentation. NO WORDS ANYWHERE. Exact 4x2 grid on real alpha transparency. Keep edges clean and sharp, with no fuzzy background halo baked into the character.
```

### pomo

```text
Use case: stylized-concept / production game sprite atlas.
Input images are CHARACTER IDENTITY REFERENCES, not backgrounds to retain. Reference 1 defines the Pizza family; reference 2 defines expression design only.
Generate a genuinely TRANSPARENT RGBA production sprite atlas containing ONLY POMO, the coral-red round tomato, THIRD character in reference 1. Preserve its soft round body, small dark green leaf crown, white pill eyes, subtle shiny skin and soft 3D volume. Do not draw a pizza slice.
Exactly 8 separate poses in a precision 4-column by 2-row regular grid, equal cells, no overlapping cells. Canvas ideally 2048x1024 (2:1). Each cell has generous identical transparent padding, centered character with identical model size and vertical anchor. The character fills about 78% of each cell, including decoration. All eight must use exactly the same recognizable character, camera angle, material, warm upper-left studio lighting and proportions. Rounded smooth realistic clay/food 3D like the approved references. Fine enough to look beautiful at 64px. No backdrop, NO white squares, no checkerboard drawn into the image, no text or labels, no borders, no contact sheet styling. Use transparent empty space around and between characters. No background shadows on white; only the faintest local translucent contact shadow if any. No other characters.
States in exact row-major order:
TOP LEFT cell 1: IDLE, upright relaxed hovering, two open vertical eyes.
TOP cell 2: THINKING, slight 12-degree inquisitive tilt and upward eyes, three tiny thought dots entirely inside the cell.
TOP cell 3: WORKING, small forward lean, focused narrowed eyes and 2 tiny soft motion ticks.
TOP RIGHT cell 4: HAPPY, gently lifted body, two white smiling curved crescent eyes (dark espresso crescents for MOZZ).
BOTTOM LEFT cell 5: CELEBRATING, a little joyful hop, subtle squash/stretch, crescent eyes, 3 tiny warm confetti pieces inside cell; keep model size same.
BOTTOM cell 6: SAD, gentle drooping posture and lowered eyes, no tears.
BOTTOM cell 7: SLEEPY, body leaning about 15 degrees, two closed short eye-lines, tiny subtle z marks inside cell.
BOTTOM RIGHT cell 8: EATING, slightly puffy body/cheeks and a tiny gold morsel with one crumb, minimal tiny mouth if needed.
Important: this is an implementation asset, not a design presentation. NO WORDS ANYWHERE. Exact 4x2 grid on real alpha transparency. Keep edges clean and sharp, with no fuzzy background halo baked into the character.
```

### basi

```text
Use case: stylized-concept / production game sprite atlas.
Input images are CHARACTER IDENTITY REFERENCES, not backgrounds to retain. Reference 1 defines the Pizza family; reference 2 defines expression design only.
Generate a genuinely TRANSPARENT RGBA production sprite atlas containing ONLY BASI, the emerald-green plump folded basil leaf, FOURTH character in reference 1. Preserve its folded pointed top, rounded teardrop bottom, subtle central fold, short white pill eyes and rich soft 3D volume. Do not draw a pizza slice.
Exactly 8 separate poses in a precision 4-column by 2-row regular grid, equal cells, no overlapping cells. Canvas ideally 2048x1024 (2:1). Each cell has generous identical transparent padding, centered character with identical model size and vertical anchor. The character fills about 78% of each cell, including decoration. All eight must use exactly the same recognizable character, camera angle, material, warm upper-left studio lighting and proportions. Rounded smooth realistic clay/food 3D like the approved references. Fine enough to look beautiful at 64px. No backdrop, NO white squares, no checkerboard drawn into the image, no text or labels, no borders, no contact sheet styling. Use transparent empty space around and between characters. No background shadows on white; only the faintest local translucent contact shadow if any. No other characters.
States in exact row-major order:
TOP LEFT cell 1: IDLE, upright relaxed hovering, two open vertical eyes.
TOP cell 2: THINKING, slight 12-degree inquisitive tilt and upward eyes, three tiny thought dots entirely inside the cell.
TOP cell 3: WORKING, small forward lean, focused narrowed eyes and 2 tiny soft motion ticks.
TOP RIGHT cell 4: HAPPY, gently lifted body, two white smiling curved crescent eyes (dark espresso crescents for MOZZ).
BOTTOM LEFT cell 5: CELEBRATING, a little joyful hop, subtle squash/stretch, crescent eyes, 3 tiny warm confetti pieces inside cell; keep model size same.
BOTTOM cell 6: SAD, gentle drooping posture and lowered eyes, no tears.
BOTTOM cell 7: SLEEPY, body leaning about 15 degrees, two closed short eye-lines, tiny subtle z marks inside cell.
BOTTOM RIGHT cell 8: EATING, slightly puffy body/cheeks and a tiny gold morsel with one crumb, minimal tiny mouth if needed.
Important: this is an implementation asset, not a design presentation. NO WORDS ANYWHERE. Exact 4x2 grid on real alpha transparency. Keep edges clean and sharp, with no fuzzy background halo baked into the character.
```


## v4 运行时说明

v4 当前使用原创程序体积生成的矢量图层，图案路径由 `apps/web/scripts/generate-pet-shapes.mjs` 重建，无 imagegen 新增素材。上述透明状态图提示词仅保留为历史过程记录，相应 PNG 已退出运行时。当前实际图与录屏见 `README.md`。
