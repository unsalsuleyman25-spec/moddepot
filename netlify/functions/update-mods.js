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

function cleanGallery(value) {
  if (Array.isArray(value)) {
    return value.map(item => cleanText(item)).filter(Boolean);
  }

  if (typeof value === "string") {
    return value.split(/\r?\n|,/).map(item => item.trim()).filter(Boolean);
  }

  return [];
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
    gallery: cleanGallery(mod.gallery),
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

function safeGitHubPath(path) {
  const cleaned = cleanText(path)
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  if (!cleaned) return "";

  if (!cleaned.startsWith("images/")) {
    throw new Error("Görsel yolu images/ klasörü içinde olmalıdır.");
  }

  if (cleaned.includes("..") || cleaned.includes("//")) {
    throw new Error("Görsel yolu güvenli değil.");
  }

  if (!/\.(jpg|jpeg|png|webp)$/i.test(cleaned)) {
    throw new Error("Görsel uzantısı jpg, jpeg, png veya webp olmalıdır.");
  }

  return cleaned;
}

function extractBase64(content) {
  const text = cleanText(content);
  if (!text) return "";

  if (text.startsWith("data:")) {
    const parts = text.split(",");
    return parts.length > 1 ? parts[1] : "";
  }

  return text;
}

async function getExistingFileSha(path, githubHeaders, owner, repo, branch) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const url = `${githubApiBase}/repos/${owner}/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: githubHeaders
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`GitHub görsel kontrolü başarısız: ${errorText}`);
  }

  const data = await response.json();
  return data.sha || null;
}

async function uploadFileToGitHub(upload, githubHeaders, owner, repo, branch) {
  const path = safeGitHubPath(upload.path);
  const contentBase64 = extractBase64(upload.content);

  if (!contentBase64) {
    throw new Error(`${path} için görsel içeriği boş.`);
  }

  if (contentBase64.length > 8 * 1024 * 1024) {
    throw new Error(`${path} görseli çok büyük. Daha küçük görsel seç.`);
  }

  const sha = await getExistingFileSha(path, githubHeaders, owner, repo, branch);
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");

  const body = {
    message: `ModDepot görsel güncellendi - ${path}`,
    content: contentBase64,
    branch
  };

  if (sha) {
    body.sha = sha;
  }

  const response = await fetch(`${githubApiBase}/repos/${owner}/${repo}/contents/${encodedPath}`, {
    method: "PUT",
    headers: {
      ...githubHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${path} GitHub'a yüklenemedi: ${errorText}`);
  }

  return path;
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
      features: {
        modsUpdate: true,
        imageUpload: true,
        galleryUpload: true
      },
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
    const uploads = Array.isArray(body.uploads) ? body.uploads : [];

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

    const githubHeaders = {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "ModDepot-Netlify-Admin"
    };

    const uploadedPaths = [];

    if (uploads.length > 0) {
      if (uploads.length > 12) {
        return send(400, {
          ok: false,
          message: "Tek seferde en fazla 12 görsel yükleyebilirsin."
        });
      }

      for (const upload of uploads) {
        const uploadedPath = await uploadFileToGitHub(upload, githubHeaders, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH);
        uploadedPaths.push(uploadedPath);
      }
    }

    const encodedPath = MODS_FILE_PATH.split("/").map(encodeURIComponent).join("/");
    const getUrl = `${githubApiBase}/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodedPath}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;

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
      message: uploads.length ? "Mod listesi ve görseller başarıyla güncellendi." : "Mod listesi başarıyla güncellendi.",
      count: cleanedMods.length,
      uploadedImages: uploadedPaths,
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
