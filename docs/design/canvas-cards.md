# Cards on canvases (design, not built yet)

Goal: put real board cards on any canvas (your own or a shared `Team/<project>/` one).
A card box always shows the card as it is now, and opening it opens the card window.

Decided with the owner (2026-11-19):
- Arrows stay plain canvas arrows. Their meaning is just the text you write on them
  (Obsidian already supports arrow labels). Nothing is saved back to cards.
- No canvases built automatically from a filter. People place the cards themselves.
- Advanced Canvas is required for team members (Mad Kanban offers a one-click install),
  and shared-canvas sync now carries every box field, so its styles sync too.

## How it works

1. **A card box is a normal text box whose text is `@<cardId>`.** Mad Kanban sees that and
   draws the card instead of the text. Because it's still a plain text box:
   - shared-canvas sync needs no changes (it's just text),
   - without Mad Kanban it still reads as `@abc123`, nothing breaks,
   - you can resize, color, group and connect it like any other box.
2. **What the box shows:** title, list (status chip), assignee avatars, due date,
   checklist progress (3/5) and priority. Done cards look faded. A card you can't see
   (another project) shows "Hidden card".
3. **Click** = open the card window (same as on the board). **Double-click** = edit the
   box text like Obsidian does, so you can still change or remove the reference.
4. **Live:** the box redraws when the card changes (same `cards` event the board uses).

## Ways to put a card on a canvas

1. **Drag a card from the board** into an open canvas (side by side). It creates the box
   where you drop it.
2. **Right-click on the empty canvas → "Add card…"**: a search picker (same ranking as the
   `@` picker in comments). Picks one or several cards; they're placed in a column.
3. **Type `@` in a canvas text box**: the same card picker as in descriptions. A box that
   holds only the reference turns into a card.

## Build steps

| # | Step | Done when |
|---|------|-----------|
| 1 | Render `@id`-only text boxes as live cards in the canvas view (desktop + phone) | Box shows the card, updates when the card changes |
| 2 | Click opens the card window; double-click edits | Both work on desktop and phone |
| 3 | "Add card…" in the canvas menu with the picker | Adds boxes at the clicked spot |
| 4 | Drag from board to canvas | Drop creates a box at the drop point |
| 5 | `@` picker inside canvas text boxes | Picking a card makes it a card box |
| 6 | Two-vault E2E on a shared canvas | Both people see the same live card |

## Questions for the owner

1. Box contents: **full** (title, list, people, due, checklist, priority) or **short**
   (title + list + people only)?
2. Card box size: fixed width you can resize, or the box grows to fit the card?
3. Should the box take the project's color as its border, or stay neutral (your canvas
   colors only)?
