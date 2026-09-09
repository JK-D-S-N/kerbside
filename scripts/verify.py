"""Headless check: does the page load, render WebGL, and survive interaction?"""
import sys, time, json
from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:4173/"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/kerbside"

errors, warnings, logs = [], [], []

with sync_playwright() as p:
    browser = p.chromium.launch(args=[
        "--use-gl=angle", "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist",
    ])
    page = browser.new_page(viewport={"width": 1680, "height": 1050}, device_scale_factor=2)
    page.on("console", lambda m: (errors if m.type == "error" else warnings if m.type == "warning" else logs).append(m.text))
    page.on("pageerror", lambda e: errors.append(f"PAGEERROR: {e}"))

    page.goto(URL, wait_until="networkidle", timeout=60000)
    page.wait_for_timeout(4000)

    # Did WebGL actually produce a scene?
    info = page.evaluate("""() => {
      const c = document.getElementById('view');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const verdict = document.getElementById('verdictFigure')?.textContent?.trim();
      const kpis = [...document.querySelectorAll('.kpi-value')].map(e => e.textContent.trim());
      const hud = document.getElementById('hud')?.textContent?.trim();
      const paths = document.querySelectorAll('.chart-svg path').length;
      return { gl: !!gl, w: c.width, h: c.height, verdict, kpis, hud, chartPaths: paths };
    }""")
    print("STATE:", json.dumps(info, indent=1))

    # Is the canvas actually painted rather than a flat fill?
    page.screenshot(path=f"{OUT}-01-default.png")

    # Interact: night, then no bus lane, then bike lane.
    page.fill("#hour", "22") if False else page.eval_on_selector(
        "#hour", "el => { el.value = 22; el.dispatchEvent(new Event('input', {bubbles:true})); }")
    page.wait_for_timeout(2500)
    page.screenshot(path=f"{OUT}-02-night.png")

    page.eval_on_selector("#hour", "el => { el.value = 8; el.dispatchEvent(new Event('input', {bubbles:true})); }")
    page.wait_for_timeout(1500)
    page.click(".preset >> text='No bus lane'")
    page.wait_for_timeout(2500)
    after_no_lane = page.evaluate("() => document.getElementById('verdictFigure').textContent.trim()")
    page.screenshot(path=f"{OUT}-03-nolane.png")

    page.click(".preset >> text='As built'")
    page.wait_for_timeout(1200)
    page.eval_on_selector("#busLoad", "el => { el.value = 95; el.dispatchEvent(new Event('input', {bubbles:true})); }")
    page.wait_for_timeout(1500)
    full = page.evaluate("""() => ({
      verdict: document.getElementById('verdictFigure').textContent.trim(),
      body: document.getElementById('verdictBody').textContent.trim(),
      kpis: [...document.querySelectorAll('.kpi-value')].map(e => e.textContent.trim()),
      deltas: [...document.querySelectorAll('.kpi-delta')].map(e => e.textContent.trim()),
    })""")
    print("FULL BUS:", json.dumps(full, indent=1))
    page.screenshot(path=f"{OUT}-04-fullbus.png")

    page.click("#findingToggle")
    page.wait_for_timeout(700)
    page.screenshot(path=f"{OUT}-05-finding.png")

    print(f"\nno-lane verdict: {after_no_lane}")
    browser.close()

print(f"\nCONSOLE ERRORS ({len(errors)}):")
for e in errors[:25]: print("  !", e[:300])
print(f"CONSOLE WARNINGS ({len(warnings)}):")
for w in warnings[:12]: print("  ~", w[:220])
sys.exit(1 if errors else 0)
