---
name: jev-computer-use
description: >
  Ultra-fast browser automation and computer use skill powered by TypeSafe's
  Jev (System One) model. Replaces slow 4-6 second visual screenshot loops with
  sub-100ms indexed DOM action tables, allowing end-to-end web workflows (like
  flight search or multi-step checkout) in 5-10 seconds total.
license: MIT
metadata:
  author: "shiba-open-source"
  version: "1.0.0"
---

# Jev Ultra-Fast Computer Use

This skill equips agents with **ultra-fast web automation** inspired by `browser-use/jev-ultrafast` and powered by **TypeSafe's Jev (System One)** model.

---

## 1. Why Traditional Vision Agents Are Slow (and How Jev Fixes It)

| Step | Standard Computer Use (Vision LLMs) | Jev Ultra-Fast (System One) |
| :--- | :--- | :--- |
| **Observation** | Takes full high-res screenshot (1–2 MB, 1000ms). | Injects `dom-extractor.js` to extract visible interactive elements (~15ms). |
| **Token Payload** | 1,500–3,000 vision tokens per turn. | 200–500 plain-text tokens representing actionable elements. |
| **Model Inference** | Calls heavy frontier model (Claude 3.5 Sonnet / GPT-4o) with image reasoning (2,500–6,000ms latency). | Calls **TypeSafe Jev (System One)** model via `POST /v1/system-one` (sub-100ms latency). |
| **Action Generation** | Predicts floating-point pixel `(x, y)` coordinates or complex XPath selectors. | Predicts exact numeric element ID `[target_index]` and `operation` in a single speculative call. |
| **Execution** | Synthesizes mouse movement; prone to scrolling/viewport misalignments. | Direct DOM node interaction / CDP coordinate click with verified bounding geometry. |
| **End-to-End Latency** | **40–70 seconds** for a 10-step task. | **5–10 seconds** for the exact same 10-step task (**8x–12x faster**). |

---

## 2. Core Architecture Pipeline

```
  [ Web Page / Browser ]
           │
           ▼ (15ms)
  [ dom-extractor.js ]
    Scans visible interactive elements
    Builds clean indexed table:
      [1] <button label="Search">
      [2] <input type="text" placeholder="Where to?">
           │
           ▼ (80ms single API call)
  [ TypeSafe Jev (System One) ]
    Speculative Decision Questions:
      1. operation: CLICK | TYPE_TEXT | SELECT | SCROLL_DOWN | WAIT | DONE
      2. target_index: 1 | 2 | 3 | ... | NONE
           │
           ▼ (10ms)
  [ Playwright / CDP / Browser Dispatch ]
    Clicks element [2] or types resolved text
           │
           ▼
  [ Loop Until DONE ]
```

---

## 3. The Speculative Decision Payload

Instead of making multiple round-trips to decide *what* to do and *where* to do it, construct **one speculative question batch** sent to TypeSafe's Jev model:

```json
{
  "model": "jev",
  "state": {
    "goal": "Search for flights from San Francisco to Tokyo on October 15",
    "current_url": "https://www.google.com/travel/flights",
    "page_title": "Google Flights",
    "recent_actions": ["CLICK [1] (Accept cookies)"],
    "interactive_elements": "[1] <button label=\"Round trip\">\n[2] <input placeholder=\"Where from?\" value=\"San Francisco\">\n[3] <input placeholder=\"Where to?\">\n[4] <button label=\"Search\">"
  },
  "questions": [
    {
      "id": "operation",
      "primitive": "choice",
      "instructions": "Determine the single next immediate browser action to advance toward the goal.",
      "criteria": {
        "options": [
          "CLICK",
          "TYPE_TEXT",
          "SELECT",
          "SCROLL_DOWN",
          "SCROLL_UP",
          "WAIT",
          "DONE",
          "FAIL"
        ]
      }
    },
    {
      "id": "target_index",
      "primitive": "choice",
      "instructions": "If operation is CLICK, TYPE_TEXT, or SELECT, choose the exact element number [ID] from the table. Otherwise choose NONE.",
      "criteria": {
        "options": ["1", "2", "3", "4", "NONE"]
      }
    }
  ]
}
```

Jev evaluates both questions concurrently over the same state in **under 100 milliseconds**, returning:
```json
{
  "answers": [
    { "id": "operation", "choice": "TYPE_TEXT" },
    { "id": "target_index", "choice": "3" }
  ]
}
```

---

## 4. Operational Instructions for Codex & ChatGPT

When asked to automate a browser task, interact with a live web UI, or test a deployed application:

### Step 1: Initialize Browser & Page
Use Playwright, Puppeteer, Chrome DevTools Protocol (CDP), or an existing MCP tool (`mcp__cua_repl__js`):
```javascript
const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();
await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
```

### Step 2: Inject the DOM Extractor
Inject `dom-extractor.js` to get the real-time indexed table:
```javascript
const snapshot = await page.evaluate(domExtractorCode);
// snapshot = { url, title, table, elements, elementCount }
```

### Step 3: Call TypeSafe Jev
Send the snapshot and goal to `https://api.typesafe.ai/v1/system-one`:
```javascript
const decision = await decideNextAction({
  goal: userGoal,
  url: snapshot.url,
  title: snapshot.title,
  table: snapshot.table,
  elementCount: snapshot.elementCount,
  recentActions: actionHistory
}, process.env.TYPESAFE_API_KEY);
```

### Step 4: Dispatch Action
Dispatch immediately using the resolved coordinates or element selector:
* **CLICK**:
  ```javascript
  const el = snapshot.elements[decision.targetIndex];
  await page.mouse.click(el.x, el.y);
  ```
* **TYPE_TEXT**:
  ```javascript
  const el = snapshot.elements[decision.targetIndex];
  await page.mouse.click(el.x, el.y);
  await page.keyboard.type(decision.textToType, { delay: 15 });
  await page.keyboard.press('Enter');
  ```
* **SCROLL_DOWN**:
  ```javascript
  await page.mouse.wheel(0, 500);
  ```
* **WAIT**:
  ```javascript
  await page.waitForTimeout(1000);
  ```
* **DONE**:
  Extract the final output, report results, and close session.

---

## 5. Handling Complex Real-World Scenarios

### Dynamic Autocomplete & Dropdowns
When typing into search or airport selectors (e.g., typing "Tokyo"):
1. The `TYPE_TEXT` action types the query.
2. The page fires dynamic AJAX results.
3. The next loop's `dom-extractor.js` snapshot immediately catches the newly rendered option elements:
   `[5] <div role="option" label="Tokyo Haneda (HND)">`
4. Jev immediately chooses `CLICK [5]` on the next turn.

### Captchas and Anti-Bot Gates
If Jev detects an insurmountable blocking condition:
- `operation` returns `FAIL`.
- The agent halts immediately and escalates to the human user rather than spinning in an infinite loop.

### Visual Verifications
If an operation requires visual confirmation (e.g. verifying an image loaded or reading a canvas map), only then take a single targeted screenshot using `view_image` or vision subagent. Never use vision as the default interactive step loop.

---

## 6. Files in this Skill
* `SKILL.md`: This comprehensive specification.
* `dom-extractor.js`: Production-ready browser evaluation script that extracts interactive elements into an indexed table.
* `runner.ts`: TypeScript client integrating TypeSafe Jev API with speculative question batching.
