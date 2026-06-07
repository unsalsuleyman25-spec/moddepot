const githubApiBase = "https://api.github.com";

const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};

function send(statusCode, data) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(data, null, 2)
  };
}

function cleanText(value, fallback = "") {
  if (value === undefined || value === null) return fallback;
  return String(value).trim();
}

function cleanMod(mod) {
  return {
    id: cleanText(mod.id),
    name: cleanText(mod.name),
    category: cleanText(mod.category, "Diğer"),
    description: cleanText(mod.description),
    version: cleanText(mod.version, "1.0"),
    size: cleanText(mod.size, "-"),
    author: cleanText(mod.author, "ModDepot"),
    addedDate: cleanText(mod.addedDate),
    image: cleanText(mod.image),
    icon: cleanText(mod.icon, "📦"),
    download: cleanText(mod.download, "#")
  };
}

function createModsJs(mods) {
  return `// ModDepot mod listesi
// Bu dosya Netlify admin sistemi tarafından otomatik güncellenir.
// Manuel düzenleme yapmadan önce yedek almanız önerilir.

window.ModDepotMods = ${JSON.stringify(mods, null, 2)};
`;
}

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: jsonHeaders,
      body: ""
    };
  }

  if (event.httpMethod === "GET") {
    return send(200, {
      ok: true,
      message: "ModDepot update-mods function aktif.",
      env: {
        owner: Boolean(process.env.GITHUB_OWNER),
        repo: Boolean(process.env.GITHUB_REPO),
        branch: Boolean(process.env.GITHUB_BRANCH),
        modsFilePath: Boolean(process.env.MODS_FILE_PATH),
        token: Boolean(process.env.GITHUB_TOKEN),
        adminPassword: Boolean(process.env.ADMIN_PASSWORD)
      }
    });
  }

  if (event.httpMethod !== "POST") {
    return send(405, {
      ok: false,
      message: "Sadece POST isteği kabul edilir."
    });
  }

  try {
    const {
      GITHUB_TOKEN,
      GITHUB_OWNER,
      GITHUB_REPO,
      GITHUB_BRANCH,
      MODS_FILE_PATH,
      ADMIN_PASSWORD
    } = process.env;

    if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO || !GITHUB_BRANCH || !MODS_FILE_PATH || !ADMIN_PASSWORD) {
      return send(500, {
        ok: false,
        message: "Netlify environment variables eksik. Ayarları kontrol edin."
      });
    }

    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch (error) {
      return send(400, {
        ok: false,
        message: "Geçersiz JSON gönderildi."
      });
    }

    const password = cleanText(body.password);
    const mods = body.mods;

    if (password !== ADMIN_PASSWORD) {
      return send(401, {
        ok: false,
        message: "Yönetim şifresi hatalı."
      });
    }

    if (!Array.isArray(mods)) {
      return send(400, {
        ok: false,
        message: "mods alanı liste olmalıdır."
      });
    }

    const cleanedMods = mods.map(cleanMod).filter((mod) => mod.id && mod.name);

    const duplicateIds = cleanedMods
      .map((mod) => mod.id)
      .filter((id, index, list) => list.indexOf(id) !== index);

    if (duplicateIds.length > 0) {
      return send(400, {
        ok: false,
        message: "Aynı Mod ID birden fazla kullanılmış.",
        duplicateIds
      });
    }

    const encodedPath = MODS_FILE_PATH.split("/").map(encodeURIComponent).join("/");
    const getUrl = `${githubApiBase}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

    const githubHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ModDepot-Netlify-Admin"
    };

    const getResponse = await fetch(getUrl, {
      method: "GET",
      headers: githubHeaders
    });

    if (!getResponse.ok) {
      const errorText = await getResponse.text();
      return send(500, {
        ok: false,
        message: "GitHub dosyası okunamadı.",
        details: errorText
      });
    }

    const fileData = await getResponse.json();
    const sha = fileData.sha;

    const newContent = createModsJs(cleanedMods);
    const encodedContent = Buffer.from(newContent, "utf8").toString("base64");

    const putResponse = await fetch(`${githubApiBase}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}`, {
      method: "PUT",
      headers: {
        ...githubHeaders,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message: `ModDepot mod listesi güncellendi - ${new Date().toLocaleString("tr-TR")}`,
        content: encodedContent,
        sha,
        branch: GITHUB_BRANCH
      })
    });

    if (!putResponse.ok) {
      const errorText = await putResponse.text();
      return send(500, {
        ok: false,
        message: "GitHub dosyası güncellenemedi.",
        details: errorText
      });
    }

    const result = await putResponse.json();

    return send(200, {
      ok: true,
      message: "Mod listesi başarıyla güncellendi.",
      count: cleanedMods.length,
      commit: result.commit && result.commit.html_url ? result.commit.html_url : null
    });
  } catch (error) {
    return send(500, {
      ok: false,
      message: "Beklenmeyen hata oluştu.",
      details: error.message
    });
  }
};