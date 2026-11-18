import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.js?url";
import JSZip from "jszip";
import * as XLSX from "xlsx";
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export const load = (k, d) => {
  try {
    const v = localStorage.getItem(k);
    return v ? JSON.parse(v) : d;
  } catch {
    return d;
  }
};
export const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* almacenamiento lleno */
  }
};
export const uid = () => Math.random().toString(36).slice(2, 9);

export const PROVIDERS = {
  openai: { label: "OpenAI (GPT)", model: "gpt-4o-mini" },
  gemini: { label: "Google Gemini", model: "gemini-2.5-flash" },
  anthropic: { label: "Anthropic (Claude)", model: "claude-sonnet-5-5" },
};

/* ---------- PDF y Moodle ---------- */
export async function pdfText(buf) {
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) })
    .promise;
  let t = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    let y = null;
    for (const x of c.items) {
      const ny = x.transform[5];
      if (y !== null) t += Math.abs(ny - y) > 2 ? "\n" : " ";
      t += x.str;
      y = ny;
    }
    t += "\n";
  }
  return t.trim();
}

// Detecta estudiante y título a partir del texto del PDF (se afina luego con la IA)
export function guessMeta(texto, archivo, moodle) {
  const lines = texto
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 30);
  const grab = (re) => {
    for (const l of lines) {
      const m = l.match(re);
      if (m && m[1].trim()) return m[1].trim();
    }
    return "";
  };
  const estudiante =
    grab(
      /^(?:nombres?|estudiantes?|alumnos?|autor(?:es|a)?|integrantes?)\s*[:\-]\s*(.{3,100})$/i,
    ) ||
    moodle ||
    archivo.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");
  const titulo =
    grab(/^(?:t[ií]tulo(?: del trabajo)?|tema)\s*[:\-]\s*(.{3,150})$/i) ||
    (
      lines.find(
        (l) =>
          l.length >= 4 &&
          !/universidad|facultad|carrera|escuela|instituto|asignatura|docente|materia|ciclo|curso|paralelo|fecha|nombre|estudiante/i.test(
            l,
          ),
      ) || ""
    ).slice(0, 120) ||
    archivo;
  return { estudiante, titulo };
}

// Acepta PDF sueltos y ZIP de Moodle ("Nombre Apellido_123_assignsubmission_file_...")
export async function importFiles(files) {
  const out = [];
  const add = async (path, buf) => {
    if (!/\.pdf$/i.test(path) || /__MACOSX/.test(path)) return;
    const m = path.match(/([^/]+?)_\d+_assignsubmission_/);
    let texto = "";
    try {
      texto = await pdfText(buf);
    } catch {
      /* PDF ilegible */
    }
    const archivo = path.split("/").pop();
    const moodle = m ? m[1].trim() : "";
    out.push({
      id: uid(),
      archivo,
      estudianteMoodle: moodle,
      ...guessMeta(texto, archivo, moodle),
      texto,
      estado: "pendiente",
      res: null,
      error: "",
    });
  };
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      const z = await JSZip.loadAsync(await f.arrayBuffer());
      for (const e of Object.values(z.files))
        if (!e.dir) await add(e.name, await e.async("arraybuffer"));
    } else await add(f.name, await f.arrayBuffer());
  }
  return out;
}

/* ---------- LLM ---------- */
const post = async (url, headers, body) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok)
    throw Object.assign(
      new Error(j.error?.message || `Error HTTP ${r.status}`),
      { status: r.status },
    );
  return j;
};

export const detectProvider = (k) =>
  k.startsWith("sk-ant")
    ? "anthropic"
    : k.startsWith("AIza") || k.startsWith("AQ.")
      ? "gemini"
      : k.startsWith("sk-")
        ? "openai"
        : null;

async function callOnce({ provider, model, key: rawKey }, prompt) {
  const key = (rawKey || "").trim();
  const det = detectProvider(key);
  if (det && det !== provider) {
    provider = det;
    model = PROVIDERS[det].model;
  }
  if (provider === "openai") {
    const j = await post(
      "https://api.openai.com/v1/chat/completions",
      { Authorization: "Bearer " + key },
      {
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [{ role: "user", content: prompt }],
      },
    );
    return j.choices[0].message.content;
  }
  if (provider === "gemini") {
    const j = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { "x-goog-api-key": key },
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      },
    );
    return j.candidates[0].content.parts[0].text;
  }
  const j = await post(
    "https://api.anthropic.com/v1/messages",
    {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    { model, max_tokens: 3000, messages: [{ role: "user", content: prompt }] },
  );
  return j.content.map((c) => c.text || "").join("");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const transient = (e) =>
  [429, 500, 502, 503, 504].includes(e.status) ||
  /high demand|overloaded|unavailable|try again/i.test(e.message);

// Reintenta si el modelo está saturado; en el último intento, Gemini usa un modelo más liviano
export async function callLLM(cfg, prompt) {
  const gem =
    (detectProvider((cfg.key || "").trim()) || cfg.provider) === "gemini";
  let last;
  for (let i = 0; i < 4; i++) {
    if (i) await sleep(i * 3000);
    try {
      return await callOnce(
        i === 3 && gem
          ? { ...cfg, provider: "gemini", model: "gemini-2.5-flash-lite" }
          : cfg,
        prompt,
      );
    } catch (e) {
      last = e;
      if (!transient(e)) throw e;
    }
  }
  throw new Error(
    last.message + " (se reintentó 4 veces; prueba de nuevo en unos minutos)",
  );
}

export function buildPrompt(ctx, rubric, w) {
  return `Eres un docente evaluador experto. Evalúa el trabajo de un estudiante usando ÚNICAMENTE la rúbrica indicada.

## CONTEXTO ACADÉMICO
Tarea: ${ctx.titulo} - ${ctx.descripcion}
Objetivos: ${ctx.objetivos}
Instrucciones: ${ctx.instrucciones}

## TEXTO BASE / FUENTE
${(ctx.base || "(no se proporcionó)").slice(0, 12000)}

## RÚBRICA
${rubric.map((c, i) => `${i + 1}. ${c.nombre} (máximo ${c.puntos} pts): ${c.descripcion}`).join("\n")}

## TRABAJO DEL ESTUDIANTE
Archivo: ${w.archivo}
Estudiante según Moodle (puede estar vacío): ${w.estudianteMoodle || "desconocido"}
Contenido:
"""
${w.texto.slice(0, 20000)}
"""

## INSTRUCCIONES
- Identifica autor(es) y título del trabajo a partir del contenido y del nombre del archivo.
- Para cada criterio asigna un puntaje entre 0 y su máximo (se permiten decimales) con una justificación breve.
- Compara con el texto base para valorar comprensión y fidelidad.
- Escribe una retroalimentación general en español, constructiva: fortalezas y aspectos a mejorar.
- Responde SOLO con JSON válido, sin texto adicional, con este formato:
{"estudiante":"...","titulo":"...","criterios":[{"nombre":"<nombre exacto del criterio>","puntaje":0,"comentario":"..."}],"retroalimentacion":"..."}`;
}

export function parseJSON(t) {
  const m = t.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("El modelo no devolvió un JSON válido");
  return JSON.parse(m[0]);
}

export function normalize(j, rubric, w) {
  const criterios = rubric.map((c, i) => {
    const r =
      j.criterios?.find((x) => x.nombre === c.nombre) || j.criterios?.[i] || {};
    const max = Number(c.puntos) || 0;
    return {
      nombre: c.nombre,
      max,
      puntaje: Math.max(0, Math.min(max, Number(r.puntaje) || 0)),
      comentario: r.comentario || "",
    };
  });
  return {
    estudiante:
      j.estudiante || w.estudiante || w.estudianteMoodle || "No identificado",
    titulo: j.titulo || w.titulo || w.archivo,
    criterios,
    total: Math.round(criterios.reduce((a, c) => a + c.puntaje, 0) * 100) / 100,
    max: criterios.reduce((a, c) => a + c.max, 0),
    retroalimentacion: j.retroalimentacion || "",
  };
}

/* ---------- Excel ---------- */
export function exportXlsx(works, ctx) {
  const rows = works
    .filter((w) => w.res)
    .map((w) => {
      const o = {
        Estudiante: w.estudiante || w.res.estudiante,
        "Título del trabajo": w.titulo || w.res.titulo,
        Archivo: w.archivo,
      };
      w.res.criterios.forEach((c) => {
        o[`${c.nombre} (/${c.max})`] = c.puntaje;
      });
      o.Total = w.res.total;
      o["Total máximo"] = w.res.max;
      o.Retroalimentación = w.res.retroalimentacion;
      return o;
    });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.json_to_sheet(rows),
    "Calificaciones",
  );
  XLSX.writeFile(
    wb,
    `calificaciones_${(ctx.titulo || "tarea").replace(/[^\w-]+/g, "_")}.xlsx`,
  );
}
