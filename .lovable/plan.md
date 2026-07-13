# Fix stray `" />` in preview

## Root cause

`index.html` line 16 is a malformed favicon `<link>` tag. The `href` attribute was HTML-escaped incorrectly and the SVG got split across the attribute boundary:

```html
<link rel="icon" type="image/x-icon"
  href="&quot;data:image/svg+xml,&lt;svg"><circle cx='50' cy='50' ... /></svg>" />
```

The browser closes the `<link>` at the first real `>`, then treats the remaining `<circle .../></svg>" />` as body content — which is the `" />` you're seeing.

## Fix

Replace line 16 with a well-formed inline SVG data URI:

```html
<link rel="icon" type="image/svg+xml"
  href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ccircle cx='50' cy='50' r='40' fill='none' stroke='%2335d6ed' stroke-width='8'/%3E%3Ccircle cx='50' cy='50' r='14' fill='%2335d6ed'/%3E%3C/svg%3E" />
```

Single attribute, URL-encoded (no stray quotes), correct MIME (`image/svg+xml`).

## Verification

1. Reload preview — no stray `" />` glyph anywhere on the page.
2. Auth screen renders normally.
3. Browser tab shows the cyan JARVIS ring favicon.

## Scope

One line in `index.html`. No other files touched.
