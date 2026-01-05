const puppeteer = require("puppeteer");
const https = require("https");

const WEBHOOK_URL = "https://n8n-koufos.onrender.com/webhook/pc/puppeteer/downdetector";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const data = Buffer.from(JSON.stringify(payload), "utf8");

    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: url.pathname + (url.search || ""),
        headers: {
          "Content-Type": "application/json",
          "Content-Length": data.length,
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            body,
          });
        });
      }
    );

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  let browser = null;

  try {
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      defaultViewport: null,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    await page.goto("https://downdetector.gr/", { waitUntil: "domcontentloaded" });
    await sleep(2500);

    // Accept cookies if exists (safe) — UNCHANGED logic
    try {
      const btn = await page.$("#onetrust-accept-btn-handler");
      if (btn) await btn.click().catch(() => {});
    } catch (e) {
      // ignore - cookie banner not present / click failed
    }
    await sleep(1200);

    // UNCHANGED wait condition
    await page.waitForFunction(() => document.querySelectorAll("h5").length > 0, {
      timeout: 15000,
    });

    // UNCHANGED scrape logic
    const rows = await page.evaluate(() => {
      const findSparkline = (root) => {
        if (!root) return null;
        return root.querySelector("svg.sparkline.danger") || root.querySelector("svg.sparkline");
      };

      return Array.from(document.querySelectorAll("h5"))
        .map((h5) => {
          const title = (h5.innerText || h5.textContent || "").trim();
          if (!title) return null;

          const container =
            h5.closest("article") ||
            h5.closest("section") ||
            h5.closest("li") ||
            h5.closest("div");

          let svg = findSparkline(container);
          if (!svg && container) svg = findSparkline(container.parentElement);

          if (!svg) {
            return {
              h5: title,
              sparkline_class: null,
              sparkline_values_raw: null,
            };
          }

          return {
            h5: title,
            sparkline_class: svg.getAttribute("class"),
            sparkline_values_raw: svg.getAttribute("data-values"),
          };
        })
        .filter(Boolean);
    });

    // Keep console output (as you had) — still useful for local debugging
    console.log(JSON.stringify(rows, null, 2));

    // NEW: send to webhook
    const payload = {
      ok: true,
      source: "downdetector.gr",
      timestamp: new Date().toISOString(),
      data: rows,
    };

    const res = await postJson(WEBHOOK_URL, payload);
    if (!res.ok) {
      throw new Error(`Webhook POST failed: ${res.status} ${res.body || ""}`);
    }

    console.log(`Webhook OK: ${res.status}`);
  } catch (err) {
    // NEW: report error to webhook too (best-effort)
    const payload = {
      ok: false,
      source: "downdetector.gr",
      timestamp: new Date().toISOString(),
      error: String(err?.message || err),
      data: null,
    };

    try {
      const res = await postJson(WEBHOOK_URL, payload);
      console.error(`Webhook ERROR report: ${res.status}`);
    } catch (e) {
      console.error("Failed to POST error to webhook:", e);
    }

    console.error("Fatal:", err);
    process.exitCode = 1;
  } finally {
    // ✅ NEW: guaranteed close (prevents orphan chrome processes / RAM burn)
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
  }
})();
