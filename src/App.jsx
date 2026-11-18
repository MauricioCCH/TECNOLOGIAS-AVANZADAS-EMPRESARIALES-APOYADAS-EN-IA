import { useState, useEffect } from 'react';
import { load, save, PROVIDERS } from './lib.js';
import Admin from './Admin.jsx';
import Evaluator from './Evaluator.jsx';

const ADMIN = { id: 'admin', nombre: 'Administrador', user: 'admin', pass: 'admin123', rol: 'admin' };

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 32 32" fill="none">
          <path d="m3 12 13-7 13 7-13 7-13-7Z" fill="currentColor" />
          <path d="M8 15v7c4.8 4 11.2 4 16 0v-7l-8 4-8-4Z" fill="currentColor" />
          <path d="M28 13v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <span className="brand-copy"><strong>Aula</strong><small>Evaluador académico</small></span>
    </div>
  );
}

function Login({ users, onLogin }) {
  const [u, setU] = useState('');
  const [p, setP] = useState('');
  const [err, setErr] = useState('');
  const go = (e) => {
    e.preventDefault();
    const x = users.find((a) => a.user === u.trim() && a.pass === p);
    x ? onLogin(x.id) : setErr('Usuario o contraseña incorrectos. Revisa los datos e inténtalo de nuevo.');
  };
  return (
    <div className="login">
      <form className="login-box" onSubmit={go}>
        <Brand />
        <div className="login-heading"><span className="eyebrow">ESPACIO DE TRABAJO</span><h1>Bienvenido</h1></div>
        <p className="muted">Califica trabajos con tu rúbrica y obtén retroalimentación automática.</p>
        <label>Usuario<input value={u} onChange={(e) => setU(e.target.value)} autoFocus autoComplete="username" /></label>
        <label>Contraseña<input type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary" type="submit">Iniciar sesión</button>
        <small className="muted">Primer ingreso: admin / admin123</small>
      </form>
    </div>
  );
}

export default function App() {
  const [users, setUsers] = useState(() => load('users', [ADMIN]));
  const [subjects, setSubjects] = useState(() => load('subjects', []));
  const [cfg, setCfg] = useState(() => load('cfg', { provider: 'openai', model: PROVIDERS.openai.model, key: '' }));
  const [meId, setMeId] = useState(() => load('me', null));
  const [view, setView] = useState('tareas');
  useEffect(() => { save('users', users); }, [users]);
  useEffect(() => { save('subjects', subjects); }, [subjects]);
  useEffect(() => { save('cfg', cfg); }, [cfg]);
  useEffect(() => { save('me', meId); }, [meId]);

  const me = users.find((u) => u.id === meId);
  if (!me) return <Login users={users} onLogin={(id) => { setView('tareas'); setMeId(id); }} />;
  const isAdmin = me.rol === 'admin';
  const NAV = isAdmin
    ? [['docentes', 'Docentes'], ['asignaturas', 'Asignaturas'], ['ia', 'Modelo de IA']]
    : [['tareas', 'Mis tareas'], ['misasig', 'Mis asignaturas']];
  const v = NAV.some(([k]) => k === view) ? view : NAV[0][0];

  return (
    <div className="app">
      <header className="topbar">
        <Brand />
        <nav className="top-nav" aria-label="Navegación principal">
          {NAV.map(([k, l]) => <button key={k} className={v === k ? 'on' : ''} aria-current={v === k ? 'page' : undefined} onClick={() => setView(k)}>{l}</button>)}
        </nav>
        <div className="account">
          <span className="avatar" aria-hidden="true">{me.nombre?.trim()?.[0]?.toUpperCase() || 'U'}</span>
          <span className="account-copy"><strong>{me.nombre}</strong><small>{isAdmin ? 'Administrador' : 'Docente'}</small></span>
          <button className="logout" onClick={() => setMeId(null)}>Salir</button>
        </div>
      </header>
      <main className="main-content">
        <div className="content-wrap">
          {!isAdmin
            ? <Evaluator key={me.id} me={me} subjects={subjects} cfg={cfg} view={v} go={setView} />
            : <Admin sec={v} users={users} setUsers={setUsers} subjects={subjects} setSubjects={setSubjects} cfg={cfg} setCfg={setCfg} />}
        </div>
      </main>
    </div>
  );
}
