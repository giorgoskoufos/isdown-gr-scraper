const puppeteer = require("puppeteer-extra"); // Αλλαγή σε extra
const StealthPlugin = require("puppeteer-extra-plugin-stealth"); // Plugin
const https = require("https");

// Ενεργοποίηση Stealth Mode (Κρύβει ότι είναι headless)
puppeteer.use(StealthPlugin());

const WEBHOOK_URL = "https://n8n-koufos.onrender.com/webhook/pc/puppeteer/downdetector";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Helper για POST requests
function postJson(urlString, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    // Προσοχή: Το base64 screenshot μπορεί να είναι μεγάλο, αυξάνουμε το όριο αν χρειαστεί στο n8n
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
  let page = null;

  try {
    console.log("Launching Stealth Puppeteer...");
    
    browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        "--no-sandbox", 
        "--disable-setuid-sandbox", 
        "--disable-dev-shm-usage",
        "--window-size=1920,1080" // Ορίζουμε μέγεθος παραθύρου
      ],
    });

    page = await browser.newPage();

    // 1. Τυχαίο Viewport για να φαίνεται φυσικό
    await page.setViewport({ width: 1366, height: 768 + Math.floor(Math.random() * 100) });

    // 2. Πιο "πλούσιο" User Agent
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    // 3. Extra headers που στέλνουν οι κανονικοί browsers
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'el-GR,el;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://www.google.com/'
    });

    console.log("Navigating...");
    
    // Χρήση waitUntil 'networkidle2' για να περιμένουμε να ηρεμήσει το δίκτυο (χρήσιμο για cloudflare challenges)
    await page.goto("https://downdetector.gr/", { waitUntil: "networkidle2", timeout: 60000 });

    // Cookie Consent Logic
    try {
      const btn = await page.$("#onetrust-accept-btn-handler");
      if (btn) {
          await btn.click();
          await sleep(1000);
      }
    } catch (e) {}

    // Έλεγχος αν υπάρχει το h5. Αν όχι, screenshot και throw.
    const h5Count = await page.evaluate(() => document.querySelectorAll("h5").length);
    
    if (h5Count === 0) {
        throw new Error("No h5 elements found (Possible Blocking)");
    }

    // --- SCRAPING LOGIC (ΙΔΙΟ) ---
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

    console.log(`Scraped ${rows.length} items.`);

    // Success Webhook
    await postJson(WEBHOOK_URL, {
      ok: true,
      source: "downdetector.gr",
      timestamp: new Date().toISOString(),
      data: rows,
    });

    console.log("Success.");

  } catch (err) {
    console.error("Error detected:", err.message);

    // --- PRO DEBUG: Screenshot to Base64 ---
    let screenshotBase64 = null;
    let pageTitle = "Unknown";
    let pageContentShort = "";

    if (page) {
        try {
            // Παίρνουμε screenshot σε base64 string (όχι αρχείο)
            screenshotBase64 = await page.screenshot({ encoding: "base64", fullPage: false });
            pageTitle = await page.title();
            const content = await page.content();
            pageContentShort = content.slice(0, 1000); // Πρώτοι 1000 χαρακτήρες για text debug
        } catch (screenshotErr) {
            console.error("Could not take screenshot:", screenshotErr);
        }
    }

    // Error Webhook με εικόνα
    const errorPayload = {
      ok: false,
      source: "downdetector.gr",
      timestamp: new Date().toISOString(),
      error: err.message,
      debug: {
        title: pageTitle,
        html_preview: pageContentShort,
        // Στο n8n μπορείς να κάνεις render αυτό το string ως εικόνα 
        // ή να το σώσεις σε binary file node.
        screenshot_base64: screenshotBase64 
      }
    };

    try {
      await postJson(WEBHOOK_URL, errorPayload);
      console.log("Error report sent to webhook.");
    } catch (e) {
      console.error("Failed to send error webhook:", e);
    }
    
    process.exitCode = 1;

  } finally {
    if (browser) await browser.close();
  }
})();