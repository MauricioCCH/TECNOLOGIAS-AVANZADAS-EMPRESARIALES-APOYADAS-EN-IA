import { Fragment, useState, useEffect } from 'react';
import { load, save, uid, pdfText, importFiles, callLLM, buildPrompt, parseJSON, normalize, exportXlsx } from './lib.js';

const RUB0 = [
  ['Estructura', 'Introducción, desarrollo y conclusión claros y bien organizados.'],
  ['Ortografía', 'Uso correcto de ortografía, acentuación y puntuación.'],
  ['Comprensión', 'Refleja las ideas principales del texto base sin errores de interpretación.'],
  ['Redacción', 'Redacción clara, coherente y con vocabulario adecuado.'],
  ['Síntesis', 'Condensa la información esencial sin copiar literalmente.'],
];
const newTask = (asignatura, titulo) => ({
  id: uid(), asignatura, titulo, descripcion: '', objetivos: '', instrucciones: '', base: '', works: [],
  rubric: RUB0.map(([nombre, descripcion]) => ({ id: uid(), nombre, descripcion, puntos: 5 })),
});
const ESTADO = { pendiente: 'Pendiente', evaluando: 'Evaluando…', evaluado: 'Evaluado', error: 'Con error' };

export default function Evaluator({ me, subjects, cfg, view, go }) {
  const mine = subjects.filter((s) => s.docentes.includes(me.id));
  const key = 'tasks_' + me.id;
  const [tasks, setTasks] = useState(() => load(key, []));
  const [cur, setCur] = useState(null);
  const [nt, setNt] = useState({ asignatura: '', titulo: '' });
  const [filtro, setFiltro] = useState('');
  useEffect(() => {
    save(key, tasks.map((t) => ({ ...t, works: t.works.map((w) => ({ ...w, estado: w.estado === 'evaluando' ? 'pendiente' : w.estado, texto: (w.texto || '').slice(0, 20000) })) })));
  }, [tasks, key]);

  const upd = (id, p) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, ...(typeof p === 'function' ? p(t) : p) } : t)));
  const updW = (id, wid, p) => setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, works: t.works.map((w) => (w.id === wid ? { ...w, ...p } : w)) } : t)));
  const create = (e) => {
    e.preventDefault();
    const t = newTask(nt.asignatura || filtro, nt.titulo.trim());
    setTasks([t, ...tasks]); setNt({ asignatura: '', titulo: '' }); setCur(t.id);
  };
  if (view === 'misasig') return (
    <div className="stack">
      <div className="head"><h1>Mis asignaturas</h1><p className="muted">Estas son las asignaturas que el administrador te asignó.</p></div>
      {mine.length === 0 ? <p className="alert">Aún no tienes asignaturas. Pide al administrador que te asigne una en Administración → Docentes.</p> : (
        <div className="cards">
          {mine.map((s) => {
            const ts = tasks.filter((x) => x.asignatura === s.nombre);
            return (
              <div className="card" key={s.id}>
                <h3>{s.nombre}</h3>
                <p className="muted">{ts.length} tareas y {ts.reduce((a, x) => a + x.works.length, 0)} trabajos importados</p>
                <button className="btn primary" onClick={() => { setFiltro(s.nombre); setCur(null); go('tareas'); }}>Ver tareas</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
  const t = tasks.find((x) => x.id === cur);
  const shown = filtro ? tasks.filter((x) => x.asignatura === filtro) : tasks;
  if (t) return <Tarea t={t} upd={(p) => upd(t.id, p)} updW={(wid, p) => updW(t.id, wid, p)} cfg={cfg} back={() => setCur(null)} />;

  return (
    <div className="stack">
      <div className="head"><h1>Mis tareas</h1>
        <p className="muted">Crea una tarea, define su contexto y rúbrica, e importa los trabajos de Moodle para calificarlos.</p></div>
      {mine.length === 0 ? (
        <div className="panel"><p className="alert">No hay asignaturas disponibles para ti. El administrador debe crearlas y asignártelas en Administración → Asignaturas.</p></div>
      ) : (
        <form className="panel row" onSubmit={create}>
          <label>Asignatura
            <select required value={nt.asignatura || filtro} onChange={(e) => setNt({ ...nt, asignatura: e.target.value })}>
              <option value="">Selecciona…</option>{mine.map((s) => <option key={s.id}>{s.nombre}</option>)}
            </select>
          </label>
          <label className="grow">Título de la nueva tarea<input required value={nt.titulo} onChange={(e) => setNt({ ...nt, titulo: e.target.value })} /></label>
          <button className="btn primary" type="submit">Crear tarea</button>
        </form>
      )}
      {mine.length > 1 && (
        <div className="tabs">
          <button className={!filtro ? 'on' : ''} onClick={() => setFiltro('')}>Todas</button>
          {mine.map((s) => <button key={s.id} className={filtro === s.nombre ? 'on' : ''} onClick={() => setFiltro(s.nombre)}>{s.nombre}</button>)}
        </div>
      )}
      {shown.length === 0 && mine.length > 0 && <p className="muted">Aún no hay tareas aquí. Crea una con el formulario de arriba.</p>}
      <div className="cards">
        {shown.map((x) => (
          <div className="card" key={x.id}>
            <span className="tag">{x.asignatura}</span>
            <h3>{x.titulo}</h3>
            <p className="muted">{x.works.filter((w) => w.res).length} de {x.works.length} trabajos evaluados</p>
            <div className="row">
              <button className="btn primary" onClick={() => setCur(x.id)}>Abrir</button>
              <button className="btn danger" onClick={() => confirm('¿Eliminar esta tarea y sus resultados?') && setTasks(tasks.filter((y) => y.id !== x.id))}>Eliminar</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Tarea({ t, upd, updW, cfg, back }) {
  const [step, setStep] = useState(1);
  const [sel, setSel] = useState({});
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const { rubric, works } = t;
  const total = rubric.reduce((a, c) => a + (Number(c.puntos) || 0), 0);
  const setC = (id, p) => upd((x) => ({ rubric: x.rubric.map((c) => (c.id === id ? { ...c, ...p } : c)) }));

  const loadBase = async (e) => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try { upd({ base: /\.pdf$/i.test(f.name) ? await pdfText(await f.arrayBuffer()) : await f.text() }); }
    catch { setMsg('No se pudo leer el documento fuente. Prueba con otro PDF o un archivo .txt.'); }
  };
  const imp = async (e) => {
    const fs = [...e.target.files]; e.target.value = '';
    if (!fs.length) return;
    setBusy(true); setMsg('Importando archivos…');
    try {
      const n = await importFiles(fs);
      upd((x) => ({ works: [...x.works, ...n] }));
      setMsg(n.length ? `Se importaron ${n.length} trabajo(s).` : 'No se encontraron PDF en los archivos seleccionados.');
    } catch (err) { setMsg('No se pudo importar: ' + err.message); }
    setBusy(false);
  };
  const run = async (w) => {
    updW(w.id, { estado: 'evaluando', error: '' });
    try {
      if (!cfg.key) throw new Error('Falta la API key. El administrador debe guardarla en Modelo de IA.');
      if (!w.texto) throw new Error('El PDF no tiene texto legible (puede ser un escaneo).');
      const j = parseJSON(await callLLM(cfg, buildPrompt(t, rubric, w)));
      const res = normalize(j, rubric, w);
      updW(w.id, { estado: 'evaluado', res, estudiante: res.estudiante, titulo: res.titulo });
    } catch (e) { updW(w.id, { estado: 'error', error: e.message }); }
  };
  const runMany = async (list) => {
    if (!total) return setMsg('Define una rúbrica con puntos antes de evaluar.');
    setBusy(true); setMsg('');
    for (const w of list) await run(w);
    setBusy(false);
  };
  const chosen = works.filter((w) => sel[w.id]);
  const done = works.filter((w) => w.res);

  return (
    <div className="stack">
      <div className="head">
        <button className="btn ghost" onClick={back}>← Volver a mis tareas</button>
        <h1>{t.titulo}</h1><span className="tag">{t.asignatura}</span>
      </div>
      <div className="tabs">
        {['Contexto', 'Rúbrica', 'Trabajos y resultados'].map((l, i) => <button key={l} className={step === i + 1 ? 'on' : ''} onClick={() => setStep(i + 1)}>{i + 1}. {l}</button>)}
      </div>

      {step === 1 && (
        <div className="panel stack">
          <label>Título de la tarea<input value={t.titulo} onChange={(e) => upd({ titulo: e.target.value })} /></label>
          <label>Descripción de la tarea<textarea rows={2} value={t.descripcion} onChange={(e) => upd({ descripcion: e.target.value })} /></label>
          <div className="grid2">
            <label>Objetivos<textarea rows={3} value={t.objetivos} onChange={(e) => upd({ objetivos: e.target.value })} /></label>
            <label>Instrucciones para el estudiante<textarea rows={3} value={t.instrucciones} onChange={(e) => upd({ instrucciones: e.target.value })} /></label>
          </div>
          <label>Texto base o documento fuente
            <textarea rows={7} value={t.base} onChange={(e) => upd({ base: e.target.value })} placeholder="Pega el texto o carga un PDF/TXT" />
          </label>
          {msg && <p className="error">{msg}</p>}
          <div className="row between"><label className="btn">Cargar PDF o TXT<input type="file" accept=".pdf,.txt" hidden onChange={loadBase} /></label>
            <button className="btn primary" onClick={() => setStep(2)}>Continuar a la rúbrica</button></div>
        </div>
      )}

      {step === 2 && (
        <div className="panel stack">
          <div className="row between"><h3>Criterios de evaluación</h3><strong>Total: {total} pts</strong></div>
          {rubric.map((c) => (
            <div className="crit" key={c.id}>
              <label>Criterio<input value={c.nombre} onChange={(e) => setC(c.id, { nombre: e.target.value })} /></label>
              <label>Puntos<input type="number" min="0" step="0.5" value={c.puntos} onChange={(e) => setC(c.id, { puntos: e.target.value })} /></label>
              <button className="btn danger" onClick={() => upd((x) => ({ rubric: x.rubric.filter((r) => r.id !== c.id) }))} aria-label={`Quitar ${c.nombre}`}>Quitar</button>
              <label className="full">Descripción<input value={c.descripcion} onChange={(e) => setC(c.id, { descripcion: e.target.value })} /></label>
            </div>
          ))}
          {rubric.length === 0 && <p className="muted">La rúbrica está vacía. Agrega al menos un criterio.</p>}
          <div className="row between"><button className="btn" onClick={() => upd((x) => ({ rubric: [...x.rubric, { id: uid(), nombre: 'Nuevo criterio', descripcion: '', puntos: 5 }] }))}>Agregar criterio</button>
            <button className="btn primary" onClick={() => setStep(3)}>Continuar a los trabajos</button></div>
        </div>
      )}

      {step === 3 && (
        <div className="panel stack">
          {!cfg.key && <p className="alert">La API key no está configurada. Un administrador debe guardarla en Modelo de IA antes de evaluar.</p>}
          <div className="row between">
            <h3>Trabajos importados</h3>
            <label className="btn primary">Importar PDF o ZIP de Moodle<input type="file" accept=".pdf,.zip" multiple hidden onChange={imp} disabled={busy} /></label>
          </div>
          {msg && <p className="muted" role="status">{msg}</p>}
          {works.length === 0 ? <p className="muted">Aún no hay trabajos. Importa el ZIP descargado de Moodle o varios PDF a la vez.</p> : (
            <>
              <div className="row">
                <button className="btn" disabled={busy || !chosen.length} onClick={() => runMany(chosen)}>Evaluar seleccionados ({chosen.length})</button>
                <button className="btn primary" disabled={busy} onClick={() => runMany(works)}>Evaluar todos ({works.length})</button>
                <button className="btn" disabled={!done.length} onClick={() => exportXlsx(works, t)}>Exportar a Excel</button>
                <button className="btn ghost" disabled={busy} onClick={() => { upd({ works: [] }); setSel({}); }}>Vaciar lista</button>
              </div>
              <div className="scroll"><table>
                <thead><tr><th><input type="checkbox" aria-label="Seleccionar todos" checked={chosen.length === works.length} onChange={(e) => setSel(e.target.checked ? Object.fromEntries(works.map((w) => [w.id, true])) : {})} /></th>
                  <th>Estudiante</th><th>Título</th><th>Archivo</th><th>Estado</th><th>Nota</th><th></th></tr></thead>
                <tbody>{works.map((w) => (
                  <Fragment key={w.id}>
                    <tr>
                      <td><input type="checkbox" aria-label={`Seleccionar ${w.archivo}`} checked={!!sel[w.id]} onChange={(e) => setSel({ ...sel, [w.id]: e.target.checked })} /></td>
                      <td><input className="cell" aria-label="Estudiante" value={w.estudiante ?? w.res?.estudiante ?? w.estudianteMoodle ?? ''} onChange={(e) => updW(w.id, { estudiante: e.target.value })} /></td>
                      <td><input className="cell" aria-label="Título" value={w.titulo ?? w.res?.titulo ?? ''} onChange={(e) => updW(w.id, { titulo: e.target.value })} /></td>
                      <td className="file">{w.archivo}</td>
                      <td><span className={'badge ' + w.estado}>{ESTADO[w.estado]}</span></td>
                      <td className="num">{w.res ? `${w.res.total} / ${w.res.max}` : '—'}</td>
                      <td className="r">
                        <button className="btn" disabled={busy} onClick={async () => { setBusy(true); await run(w); setBusy(false); }}>{w.res ? 'Reevaluar' : 'Evaluar'}</button>
                        {(w.res || w.error) && <button className="btn ghost" onClick={() => setOpen(open === w.id ? null : w.id)}>{open === w.id ? 'Ocultar' : 'Detalle'}</button>}
                      </td>
                    </tr>
                    {open === w.id && (
                      <tr className="detail"><td colSpan={7}>
                        {w.error && <p className="error">{w.error}</p>}
                        {w.res && <>
                          <ul>{w.res.criterios.map((c) => <li key={c.nombre}><strong>{c.nombre}: {c.puntaje}/{c.max}</strong> {c.comentario}</li>)}</ul>
                          <p><strong>Retroalimentación:</strong> {w.res.retroalimentacion}</p>
                        </>}
                      </td></tr>
                    )}
                  </Fragment>
                ))}</tbody>
              </table></div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
