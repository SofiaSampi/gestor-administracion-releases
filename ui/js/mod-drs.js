/* Módulo DRS FORD (nativo desde 1.0.3; reemplaza a la webapp 02 embebida).
   Datos: datos/drs/datos_drs_2026.json (mismo formato que la webapp):
     drs[]          {drs, np, item, periodo, anio, carpeta, obs, archivo, fecha}   (fecha: del PDF subido, desde 1.0.3)
     resumenLista[] {num, closed, factura}      retroLista[] {num, closed, factura}
     registros{drs} {retros:[{num, val}], resNum, resUnit, resQty}
     np{np}         {emp, serv, cod}
   Subsectores: Resúmenes · Retroactivos · Buscador · Notas de pedido */
(function(){
  const {sys, ui, db, auth, path} = LS;
  const {esc} = ui; const I = LS.icon;
  const ARCH = () => db.p.datos('drs', 'datos_drs_2026.json');
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const ORDEN = Object.fromEntries(MESES.map((m,i)=>[m, i+1]));
  const EMPRESAS = ['Linksolution SRL','Tectuary Core SA'], SERVICIOS = ['Contact Center','Soporte IT'];
  const LBL = {resumen:'Resumen', retro:'Retroactivo'};
  const LISTA = {resumen:'resumenLista', retro:'retroLista'};
  /* Acepta "1.234,56", "1234,56", "$ 1.500" y los números que trae el Excel de Ford ("1500.5", "0.969").
     Un punto con 3 decimales se toma como separador de miles, salvo que la parte entera sea 0 (ej. cantidad 0.969). */
  const numOf = v => { if(typeof v==='number') return v; const s = String(v==null?'':v).trim();
    if(/^-?0\.\d+$/.test(s) || /^-?\d+\.(\d{1,2}|\d{4,})$/.test(s)) return parseFloat(s);
    const n = parseFloat(s.replace(/[^0-9.,-]/g,'').replace(/\.(?=\d{3}(\D|$))/g,'').replace(',','.')); return isNaN(n) ? 0 : n; };
  const fmt = n => Number(n||0).toLocaleString('es-AR', {minimumFractionDigits:2, maximumFractionDigits:2});
  const fmtF = iso => iso ? String(iso).slice(0,10).split('-').reverse().join('/') : '';
  const periodStr = r => r.periodo ? r.periodo + (r.anio ? ' '+r.anio : '') : '';
  const pKey = p => { const s = String(p).trim().split(/\s+/); return (s[1] ? parseInt(s[1],10) : 0)*100 + (ORDEN[s[0]]||99); };
  const isoDia = ms => { const d = new Date(ms); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };

  /* ---------- Lectura de nombres de carpetas / archivos (igual que la webapp) ---------- */
  const MES_NOM = {enero:'Enero',febrero:'Febrero',marzo:'Marzo',abril:'Abril',mayo:'Mayo',junio:'Junio',julio:'Julio',agosto:'Agosto',septiembre:'Septiembre',setiembre:'Septiembre',octubre:'Octubre',noviembre:'Noviembre',diciembre:'Diciembre'};
  const NOTEMON = [['enero','Enero'],['febrero','Febrero'],['marzo','Marzo'],['abril','Abril'],['mayo','Mayo'],['junio','Junio'],['julio','Julio'],['agosto','Agosto'],['septiembre','Septiembre'],['octubre','Octubre'],['noviembre','Noviembre'],['diciembre','Diciembre'],
    ['ene','Enero'],['feb','Febrero'],['mar','Marzo'],['abr','Abril'],['may','Mayo'],['jun','Junio'],['jul','Julio'],['ago','Agosto'],['sep','Septiembre'],['oct','Octubre'],['nov','Noviembre'],['dic','Diciembre']];
  function monthOf(n){ const s = String(n).toLowerCase(); for(const k in MES_NOM){ if(s.includes(k)) return MES_NOM[k]; } return null; }
  function yearOf(n){ const m = String(n).match(/(20\d{2})/); return m ? m[1] : ''; }
  function parseName(fname, mes, anio, isSub){
    const base = fname.replace(/\.pdf$/i,''); const segs = base.split(' - ').map(s=>s.trim());
    const np = segs[0]||'', item = segs[1]||'', rest = segs[2]||'';
    const dm = rest.match(/^(\d+)/); const drs = dm ? dm[1] : rest;
    let note = dm ? rest.slice(dm[0].length) : ''; note = note.replace(/_/g,' ').trim();
    let periodo = mes||'', an = anio||''; const low = note.toLowerCase();
    for(const [tok, m] of NOTEMON){ const re = new RegExp('(^|[^a-z])'+tok+'(?![a-z])'); const mm = low.match(re); if(mm){ periodo = m; const idx = mm.index + mm[0].length; const ym = low.slice(idx).match(/^\s*(\d{2})/); if(ym) an = '20'+ym[1]; break; } }
    return {drs, np, item, periodo, anio:an, carpeta: mes ? (mes+(isSub?' / Subidos':'')) : (isSub?'Subidos':''), obs:note, archivo:fname};
  }
  async function escanear(dir, mes, anio, isSub, out){
    for(const e of await sys.list(dir)){
      const p = path.join(dir, e.name);
      if(!e.is_dir){ if(/\.pdf$/i.test(e.name)){ const r = parseName(e.name, mes, anio, isSub); r.fecha = isoDia(e.mtime); out.push(r); } continue; }
      const mm = monthOf(e.name);
      if(mm) await escanear(p, mm, yearOf(e.name), false, out);
      else if(mes) await escanear(p, mes, anio, true, out);
      else await escanear(p, null, '', false, out);
    }
  }
  /* Nº de comprobante en el nombre del PDF ("FACTURA A00005-00001234", "FC A 00005-00001234", "ND A …") */
  function invoiceFromName(name){ const m = String(name).match(/(?<![A-Za-z])(?:FACTURA|NOTA[\s_]+DE[\s_]+D[EÉ]BITO|FC|ND)[\s_]*A[\s_]*(\d{5})-(\d{8})/i); return m ? 'A'+m[1]+'-'+m[2] : null; }
  async function listarPdfs(dir, out, skip){ for(const e of await sys.list(dir)){ const p = path.join(dir, e.name); if(e.is_dir) await listarPdfs(p, out, skip); else if(/\.pdf$/i.test(e.name)){ const inv = invoiceFromName(e.name); if(inv) out.push({p, inv}); else skip.push(e.name); } } }

  /* ---------- Librerías (van en ui/lib, se cargan solo cuando hacen falta) ---------- */
  const cargarScript = src => new Promise((res, rej)=>{ if(document.querySelector(`script[data-lib="${src}"]`)) return res(); const s = document.createElement('script'); s.src = src; s.dataset.lib = src; s.onload = res; s.onerror = ()=>rej('No se pudo cargar '+src); document.head.appendChild(s); });
  async function pdfjs(){
    if(!window.pdfjsLib) await cargarScript('lib/pdf.min.js');
    if(!pdfjs.listo){ const url = new URL('lib/pdf.worker.min.js', location.href).href;
      try{ const code = await (await fetch(url)).text(); pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([code], {type:'text/javascript'})); }catch(e){ pdfjsLib.GlobalWorkerOptions.workerSrc = url; }
      pdfjs.listo = true; }
    return window.pdfjsLib;
  }
  async function xlsxLib(){ if(!window.XLSX) await cargarScript('lib/xlsx.full.min.js'); return window.XLSX; }

  /* ================= INTERFAZ ================= */
  LS.nativos.drs = { montar(root, ctx){
    const doc = new LS.Doc(ARCH());
    let S = null;
    const RO = () => ctx.readonly;
    const st = {sec:'resumenes',
      res:{estado:'abiertos'}, gRes:{filtros:{}, orden:null}, selRes:null, gResD:{filtros:{}, orden:{k:'drs', dir:'asc'}},
      ret:{estado:'abiertos'}, gRet:{filtros:{}, orden:null}, selRet:null, gRetD:{filtros:{}, orden:{k:'drs', dir:'asc'}},
      bus:{estado:'Pendiente'}, gBus:{filtros:{}, orden:{k:'periodo', dir:'asc'}},
      gNp:{filtros:{}, orden:{k:'np', dir:'asc'}}};

    /* ---- acceso a los datos (sobre un estado S cualquiera: el de pantalla o el que se está guardando) ---- */
    const lista = (d, t) => d[LISTA[t]];
    const reg = (d, n) => d.registros[n] || (d.registros[n] = {retros:[], resNum:'', resUnit:'', resQty:''});
    const getRetros = (d, n) => (d.registros[n] && d.registros[n].retros) || [];
    const getResNum = (d, n) => (d.registros[n] && d.registros[n].resNum) || '';
    const getRU = (d, n) => (d.registros[n] && d.registros[n].resUnit) || '';
    const getRQ = (d, n) => (d.registros[n] && d.registros[n].resQty) || '';
    const resTotal = (d, n) => { const u = getRU(d,n), q = getRQ(d,n); return (u===''||q==='') ? 0 : numOf(u)*numOf(q); };
    const npDe = (d, np) => d.np[np] || {};
    /* Empresa de un DRS: si la NP cambió de empresa, se toma la vigente en el período del DRS (1.0.4) */
    const perKey = r => (r.anio||'0000')+'-'+String(ORDEN[r.periodo]||0).padStart(2,'0');
    function empDe(d, r){
      const n = d.np[r.np] || {}; const h = n.empHist;
      if(!h || !h.length) return n.emp || '';
      const k = perKey(r); let e = '';
      h.slice().sort((a,b)=>a.desde.localeCompare(b.desde)).forEach(x=>{ if(x.desde <= k) e = x.emp; });
      return e;
    }
    /* Cambio de empresa a partir de un período (AAAA-MM): los DRS anteriores conservan la empresa que tenían */
    function empDesde(d, np, emp, desde){
      const n = d.np[np] = d.np[np] || {emp:'', serv:'', cod:''};
      if(!n.empHist || !n.empHist.length) n.empHist = [{desde:'0000-00', emp:n.emp||''}];
      n.empHist = n.empHist.filter(x=>x.desde!==desde).concat([{desde, emp, cargado:ui.hoy()}]).sort((a,b)=>a.desde.localeCompare(b.desde));
      n.emp = n.empHist[n.empHist.length-1].emp;
    }
    const perLabel = k => k==='0000-00' ? 'el inicio' : (MESES[Number(k.slice(5))-1]||'')+' '+k.slice(0,4);
    const isClosed = (d, t, num) => { const it = lista(d,t).find(x=>x.num===num); return it ? !!it.closed : false; };
    const facturaDe = (d, t, num) => { const it = lista(d,t).find(x=>x.num===num); return it ? (it.factura||'') : ''; };
    const drsDe = (d, t, num) => d.drs.filter(r=> t==='retro' ? getRetros(d, r.drs).some(e=>e.num===num) : getResNum(d, r.drs)===num);
    const stats = (d, t, num) => { const ds = drsDe(d, t, num); const s = t==='retro' ? ds.reduce((a,r)=>a+getRetros(d, r.drs).filter(e=>e.num===num).reduce((b,e)=>b+numOf(e.val),0),0) : ds.reduce((a,r)=>a+resTotal(d, r.drs),0); return {c:ds.length, s}; };
    const estadoDrs = (d, r) => { const res = getResNum(d, r.drs); const rets = getRetros(d, r.drs).filter(e=>e.num); return (res && isClosed(d,'resumen',res) && rets.every(e=>isClosed(d,'retro',e.num))) ? 'Completado' : 'Pendiente'; };
    /* 1.0.15: empresa de facturación del retroactivo (la elegida al crearlo; si no tiene, la de sus DRS cuando es una sola) */
    const empRetro = (d, num) => { const it = lista(d,'retro').find(x=>x.num===num); if(it && it.emp) return it.emp; const es = [...new Set(drsDe(d,'retro',num).map(r=>empDe(d, r)).filter(Boolean))]; return es.length===1 ? es[0] : ''; };
    function asegurar(d, t, num){ num = String(num).trim(); if(!/^\d+$/.test(num)) throw `"${num}" no es un número de ${LBL[t].toLowerCase()} válido (solo dígitos).`; if(!lista(d,t).some(x=>x.num===num)) lista(d,t).push({num, closed:false}); return num; }
    function normalizar(d){ d.version = d.version||1; d.drs = d.drs||[]; d.retroLista = d.retroLista||[]; d.resumenLista = d.resumenLista||[]; d.np = d.np||{}; d.registros = d.registros||{}; d.drs.forEach(r=>{ if(r.anio==null) r.anio = '2026'; }); return d; }

    async function cargar(){
      try{
        if(!(await sys.exists(ARCH()))) await LS.shell.importarLegado(ctx.tab);
        if(!(await sys.exists(ARCH()))){
          if(RO()){ root.innerHTML = `<div class="scroll"><div class="empty">${I('truck')}<br>DRS Ford todavía no tiene datos en el programa. La administradora los carga la primera vez que abre el módulo.</div></div>`; return false; }
          await sys.mkdir(db.p.datos('drs')); await sys.writeJSON(ARCH(), normalizar({}), 0);
        }
        await doc.load(); S = normalizar(doc.data);
        return true;
      }catch(e){ root.innerHTML = `<div class="scroll"><div class="banner danger">${I('alert')} No se pudo leer la base de DRS: ${esc(sys.errMsg(e))}</div></div>`; return false; }
    }
    async function guardar(fn, msg){
      if(RO()){ ui.toast('Modo consulta: no se puede guardar.'); return false; }
      try{
        let previo = null, res;
        await doc.update(d=>{ previo = JSON.stringify(d, null, 1); normalizar(d); res = fn(d); });
        S = normalizar(doc.data);
        if(previo) LS.shell.pushUndo('drs', {archivo:'datos_drs_2026.json', text:previo, desc: msg || 'Cambio en DRS'});
        ctx.estado('Guardado '+new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}));
        if(msg) LS.log('drs', msg);
        return res === undefined ? true : res;
      }catch(e){ ui.alerta(esc(sys.errMsg(e)), 'No se pudo guardar'); return false; }
    }
    const scroll = (html, keep) => { const sc = {}; root.querySelectorAll('[data-keep]').forEach(el=> sc[el.dataset.keep] = el.scrollTop);
      root.innerHTML = `<div class="scroll" data-keep="${keep||st.sec}">${html}</div>`; root.querySelectorAll('[data-keep]').forEach(el=>{ if(sc[el.dataset.keep]!=null) el.scrollTop = sc[el.dataset.keep]; }); return root.firstElementChild; };

    /* ================= CARGAS ================= */
    async function elegirEmpresa(msg){
      return ui.modal({titulo:'Empresa', html:`<p style="margin-top:0">${esc(msg)}</p><p>¿A qué empresa corresponden?</p>`, botones:[{txt:'Cancelar', val:null},{txt:EMPRESAS[1], val:EMPRESAS[1], primary:true},{txt:EMPRESAS[0], val:EMPRESAS[0], primary:true}]});
    }
    async function subirDrs(){
      if(RO()) return;
      const dir = await sys.pickFolder('Elegí la carpeta del mes con los DRS (ej. "05 - Mayo 2026")'); if(!dir) return;
      const nombre = path.basename(dir); const out = [];
      ui.toast('Leyendo la carpeta…');
      try{ await escanear(dir, monthOf(nombre), yearOf(nombre), false, out); }catch(e){ return ui.alerta('No se pudo leer la carpeta: '+esc(sys.errMsg(e))); }
      if(!out.length) return ui.alerta(`No se encontraron PDF en "<b>${esc(nombre)}</b>". Elegí la carpeta del mes (ej. "Diciembre 2025" o "12 - Diciembre 2025") o la que las contiene.`);
      const sinMes = out.filter(r=>!r.periodo);
      if(sinMes.length){ const a = await ui.pedir(`No pude saber el MES de ${sinMes.length} archivo(s). Escribí el mes (Enero … Diciembre) o cancelá para omitirlos:`, {valor:monthOf(nombre)||''});
        const mm = a && MES_NOM[a.trim().toLowerCase()]; if(mm) sinMes.forEach(r=>r.periodo = mm); else for(let k=out.length-1;k>=0;k--) if(!out[k].periodo) out.splice(k,1); }
      const sinAnio = out.filter(r=>r.periodo && !r.anio);
      if(sinAnio.length){ const a = await ui.pedir(`No pude saber el AÑO de ${sinAnio.length} archivo(s). Escribí el año (ej. 2026) o cancelá para omitirlos:`, {valor:yearOf(nombre)||String(new Date().getFullYear())});
        if(a && /^20\d{2}$/.test(a.trim())) sinAnio.forEach(r=>r.anio = a.trim()); else for(let k=out.length-1;k>=0;k--) if(out[k].periodo && !out[k].anio) out.splice(k,1); }
      if(!out.length) return;
      const emp = await elegirEmpresa(`Se encontraron ${out.length} DRS en "${nombre}".`); if(!emp) return;
      // cambios de período a confirmar
      const ex = new Map(S.drs.map(d=>[d.drs, d]));
      const cambios = out.filter(r=>{ const e = ex.get(r.drs); return e && r.periodo && periodStr(e)!==periodStr(r); });
      let actualizarPer = false;
      if(cambios.length) actualizarPer = await ui.confirmar(`Hay <b>${cambios.length}</b> DRS ya cargados con un período distinto al de la carpeta:<br><div class="mono sm" style="max-height:160px;overflow:auto;margin:6px 0">${cambios.slice(0,30).map(r=>{ const e = ex.get(r.drs); return `DRS ${esc(r.drs)} (NP ${esc(e.np)}, ítem ${esc(e.item)}): ${esc(periodStr(e)||'—')} → ${esc(periodStr(r))}`; }).join('<br>')}</div>¿Actualizar esos períodos? (no afecta resúmenes ni retroactivos)`, {si:'Actualizar períodos', no:'Dejar como están'});
      const nps = [...new Set(out.map(r=>r.np).filter(Boolean))];
      const conflEmp = nps.filter(np=>{ const c = (S.np[np]||{}).emp; return c && c!==emp; });
      let cambiarEmp = false;
      if(conflEmp.length) cambiarEmp = await ui.confirmar(`${conflEmp.length} nota(s) de pedido ya tenían otra empresa: ${esc(conflEmp.slice(0,10).join(', '))}${conflEmp.length>10?'…':''}<br>¿Pasarlas a <b>${esc(emp)}</b> a partir de los períodos de esta carga?<br><span class="muted">Los DRS anteriores conservan la empresa que tenían.</span>`, {si:'Cambiar desde esta carga', no:'Dejarlas'});
      const r = await guardar(d=>{
        const by = new Map(d.drs.map(x=>[x.drs, x])); let nuevos = 0, upd = 0, fechas = 0; const col = [];
        out.forEach(o=>{ if(!o.drs) return; const e = by.get(o.drs);
          if(!e){ d.drs.push(o); by.set(o.drs, o); nuevos++; return; }
          if(e.np!==o.np) col.push(`${o.drs} (base: NP ${e.np} / archivo: NP ${o.np})`);
          if(!e.fecha && o.fecha){ e.fecha = o.fecha; fechas++; }
          if(actualizarPer && o.periodo && periodStr(e)!==periodStr(o)){ e.periodo = o.periodo; e.anio = o.anio; e.carpeta = o.carpeta; upd++; } });
        let empSet = 0; nps.forEach(np=>{ d.np[np] = d.np[np] || {emp:'', serv:'', cod:''};
          if(!d.np[np].emp){ d.np[np].emp = emp; empSet++; }
          else if(cambiarEmp && d.np[np].emp!==emp){
            // la empresa nueva rige desde el período más viejo de esta carga: los DRS anteriores conservan la suya
            const desde = out.filter(o=>o.np===np && o.periodo).map(perKey).sort()[0] || ui.hoy().slice(0,7);
            empDesde(d, np, emp, desde); empSet++; } });
        const cerradas = nps.filter(np=>d.np[np] && d.np[np].cerrada);
        return {nuevos, upd, fechas, col, empSet, cerradas};
      }, `Subió DRS de "${nombre}" (${emp})`);
      if(!r) return;
      ui.alerta(`<b>${esc(emp)}</b><ul style="margin:6px 0"><li>DRS nuevos agregados: <b>${r.nuevos}</b></li><li>Períodos corregidos: ${r.upd}</li><li>Ya existentes sin cambios: ${out.length-r.nuevos-r.upd}</li>${r.fechas?`<li>DRS a los que se les completó la fecha: ${r.fechas}</li>`:''}<li>Notas de pedido marcadas como ${esc(emp)}: ${r.empSet}</li></ul>${r.col.length?`<div class="txt-warn"><b>Revisar</b>: DRS repetidos con distinta nota de pedido:<br>${esc(r.col.slice(0,10).join(' · '))}</div>`:''}${r.cerradas.length?`<div class="txt-warn" style="margin-top:6px"><b>Atención</b>: se cargaron DRS en nota(s) de pedido cerrada(s): ${esc(r.cerradas.join(', '))}. Revisalas en Notas de pedido.</div>`:''}`, 'DRS cargados');
      render();
    }
    /* 1.0.12: un DRS exportado desde "Rellenar DRS" se suma solo a la base.
       N° de DRS: del nombre del archivo (NP - ítem - DRS); NP e ítem: de los campos (o del nombre); período: del campo del mes;
       empresa: la del encabezado; fecha: hoy. Si el DRS ya estaba, solo se completa lo que falta y se avisa si algo no coincide. */
    async function altaDesdeRellenar(x){
      if(RO()) return null;
      const p = parseName(x.archivo, '', '', false);
      const drs = (String(p.drs).match(/^\d+/)||[''])[0];
      if(!drs) return {msg:'no se sumó a la base de DRS (el nombre no tiene el N° de DRS)'};
      const np = (x.np || p.np || '').trim(), item = (x.item || p.item || '').trim();
      const periodo = monthOf(x.mes||'') || p.periodo || '', anio = periodo ? (yearOf(x.mes||'') || p.anio || String(new Date().getFullYear())) : '';
      const emp = EMPRESAS.find(e=> x.empresa && ui.norm(e).split(' ')[0]===ui.norm(x.empresa).split(' ')[0]) || '';
      const o = {drs, np, item, periodo, anio, carpeta: periodo ? periodo+' '+anio : '', obs:'', archivo:x.archivo, fecha:ui.hoy()};
      const r = await guardar(d=>{
        const e = d.drs.find(z=>z.drs===drs); const dif = [], comp = [];
        if(!e) d.drs.push(o);
        else {
          [['np','nota de pedido'],['item','ítem']].forEach(([k,l])=>{ if(!o[k]) return; if(!e[k]){ e[k] = o[k]; comp.push(l); } else if(String(e[k])!==String(o[k])) dif.push(`${l}: en la base <b>${esc(e[k])}</b>, en el PDF <b>${esc(o[k])}</b>`); });
          if(o.periodo){ if(!e.periodo){ e.periodo = o.periodo; e.anio = o.anio; if(!e.carpeta) e.carpeta = o.carpeta; comp.push('período'); } else if(periodStr(e)!==periodStr(o)) dif.push(`período: en la base <b>${esc(periodStr(e))}</b>, en el PDF <b>${esc(periodStr(o))}</b>`); }
          if(!e.fecha){ e.fecha = o.fecha; comp.push('fecha'); }
          if(!e.archivo){ e.archivo = o.archivo; }
        }
        if(np){ d.np[np] = d.np[np] || {emp:'', serv:'', cod:''};
          if(emp && !d.np[np].emp) d.np[np].emp = emp;
          else if(emp && d.np[np].emp!==emp) dif.push(`la nota de pedido ${esc(np)} figura como <b>${esc(d.np[np].emp)}</b> y el DRS se exportó con el encabezado de <b>${esc(emp)}</b>`); }
        return {nuevo:!e, dif, comp, cerrada: !!(np && d.np[np] && d.np[np].cerrada)};
      }, `Rellenar DRS: DRS ${drs} (NP ${np||'—'}) agregado desde un PDF exportado`);
      if(!r) return null;
      const avisos = [...r.dif]; if(r.cerrada) avisos.push(`la nota de pedido ${esc(np)} está <b>cerrada</b>`);
      if(!o.periodo && r.nuevo) avisos.push('no encontré el mes del servicio en la hoja: el DRS quedó <b>sin período</b> (completalo en la base)');
      const msg = r.nuevo ? `DRS ${drs} agregado a la base` : r.comp.length ? `DRS ${drs} ya estaba en la base: se completó ${r.comp.join(', ')}` : `DRS ${drs} ya estaba en la base`;
      return {msg, aviso: avisos.length ? `<b>DRS ${esc(drs)}</b>${r.nuevo?' (agregado)':' (ya estaba en la base)'} — revisá:<ul style="margin:6px 0">${avisos.map(a=>'<li>'+a+'</li>').join('')}</ul>${r.dif.length?'<span class="muted sm">No se cambió nada de lo que ya estaba cargado.</span>':''}` : ''};
    }
    async function subirFacturas(){
      if(RO()) return;
      // 1.0.10: se pueden elegir varios PDF a la vez o una carpeta entera
      const modo = await ui.modal({titulo:'Subir facturas', html:'<p style="margin-top:0">¿Qué querés elegir?</p><p class="muted sm">Podés seleccionar varios PDF juntos (Ctrl o Shift + clic) o una carpeta completa.</p>',
        botones:[{txt:'Cancelar', val:null},{txt:'Una carpeta', val:'dir'},{txt:'Archivos (varios)', val:'files', primary:true}]});
      if(!modo) return;
      const files = [], skip = [];
      if(modo==='dir'){
        const dir = await sys.pickFolder('Elegí la carpeta con las facturas / notas de débito emitidas'); if(!dir) return;
        try{ await listarPdfs(dir, files, skip); }catch(e){ return ui.alerta('No se pudo leer la carpeta: '+esc(sys.errMsg(e))); }
      } else {
        const sel = await sys.pickFiles('Elegí las facturas / notas de débito (podés elegir varias)', ['pdf']); if(!sel.length) return;
        sel.forEach(p=>{ const n = path.basename(p); const inv = invoiceFromName(n); if(inv) files.push({p, inv}); else skip.push(n); });
      }
      if(!files.length) return ui.alerta(`No se encontraron facturas ni notas de débito en esa carpeta.<br><br>Nombres aceptados:<br>• FACTURA A00005-00001234 / NOTA DE DEBITO A00005-00001234<br>• FC A 00005-00001234 / ND A 00003-00000322${skip.length?`<br><br>PDF ignorados (${skip.length}): ${esc(skip.slice(0,8).join(', '))}`:''}`);
      let lib; try{ lib = await pdfjs(); }catch(e){ return ui.alerta(esc(sys.errMsg(e))); }
      const prog = document.createElement('div'); prog.className = 'aviso-inact'; document.body.appendChild(prog);
      const hall = []; const malos = []; let hechos = 0;
      prog.innerHTML = `${I('receipt')}<span>Leyendo comprobantes… <b>0</b> de ${files.length}</span>`;
      // Se leen de a 4 en paralelo
      const leerUno = async ({p, inv}) => {
        try{
          const pdf = await lib.getDocument({data: await sys.readBytes(p)}).promise; let text = '';
          for(let n=1;n<=pdf.numPages;n++){ const tc = await (await pdf.getPage(n)).getTextContent(); text += ' '+tc.items.map(x=>x.str).join(' '); }
          if(text.trim().length < 15){ malos.push(inv+' (no se pudo leer el texto: ¿es un escaneo?)'); return; }
          const mr = text.match(/RESUMEN\s*DE\s*ENTREGA\s*[:\-]?\s*(\d{3,})/i), md = text.match(/N[UÚ]MERO\s*DE\s*RETROACTIVO\s*[:\-]?\s*(\d{3,})/i);
          if(!mr && !md){ malos.push(inv+' (sin nº de resumen ni de retroactivo legible)'); return; }
          if(mr) hall.push({t:'resumen', num:mr[1], inv}); if(md) hall.push({t:'retro', num:md[1], inv});
        }catch(e){ malos.push(inv+' (error de lectura)'); }
        finally{ hechos++; prog.innerHTML = `${I('receipt')}<span>Leyendo comprobantes… <b>${hechos}</b> de ${files.length}</span>`; }
      };
      const cola = files.slice(); await Promise.all(Array.from({length:Math.min(4, cola.length)}, async ()=>{ while(cola.length) await leerUno(cola.shift()); }));
      prog.remove();
      const r = await guardar(d=>{ let vinc = 0; const creados = [];
        hall.forEach(h=>{ let it = lista(d, h.t).find(x=>x.num===h.num); if(!it){ asegurar(d, h.t, h.num); it = lista(d, h.t).find(x=>x.num===h.num); creados.push(LBL[h.t]+' '+h.num+' ('+h.inv+')'); } it.factura = h.inv; vinc++; });
        return {vinc, creados}; }, `Subió facturas (${hall.length} vinculadas)`);
      if(!r) return;
      ui.alerta(`Comprobantes encontrados: <b>${files.length}</b><ul style="margin:6px 0"><li>Vinculados a su resumen / retroactivo: <b>${r.vinc}</b></li><li>Con problemas: ${malos.length}</li></ul>${r.creados.length?`<b>Nuevos creados y abiertos</b> (asigná sus DRS y después cerralos):<div class="sm">${esc(r.creados.slice(0,30).join(' · '))}</div>`:''}${malos.length?`<br><b>A revisar</b>:<div class="sm">${esc(malos.slice(0,20).join(' · '))}</div>`:''}${skip.length?`<br><span class="muted sm">PDF ignorados por nombre (${skip.length}): ${esc(skip.slice(0,8).join(', '))}</span>`:''}`, 'Facturas leídas');
      render();
    }
    /* 1.0.10: carga masiva. Se pueden elegir varios Resúmenes / Retroactivos: se leen en paralelo y se procesan uno tras otro. */
    async function subirFord(){
      if(RO()) return;
      const sel = await sys.pickFiles('Elegí los Resúmenes o Retroactivos (.xls) descargados de Ford (podés elegir varios)', ['xls','xlsx']); if(!sel.length) return;
      const prog = document.createElement('div'); prog.className = 'aviso-inact'; prog.innerHTML = `${I('receipt')}<span>Leyendo ${sel.length} archivo(s)…</span>`; document.body.appendChild(prog);
      let X; try{ X = await xlsxLib(); }catch(e){ prog.remove(); return ui.alerta(esc(sys.errMsg(e))); }
      const leidos = await Promise.all(sel.map(async f=>{ try{ const wb = X.read(await sys.readBytes(f), {type:'array'}); return {f, rows:X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], {header:1, raw:true, defval:null})}; }catch(e){ return {f, err:'No se pudo leer el archivo: '+sys.errMsg(e)}; } }));
      const res = [];
      for(let k=0;k<leidos.length;k++){ const x = leidos[k]; prog.innerHTML = `${I('receipt')}<span>Procesando <b>${k+1}</b> de ${leidos.length}: ${esc(path.basename(x.f))}</span>`;
        res.push(Object.assign({nombre:path.basename(x.f)}, x.err ? {err:x.err} : await procesarFord(x.rows))); }
      prog.remove();
      if(res.length===1){ const r = res[0]; if(r.err) ui.alerta(esc(r.err)); else ui.alerta(r.html, r.titulo); }
      else ui.alerta(`<p style="margin-top:0">Se procesaron <b>${res.length}</b> archivos (${res.filter(r=>!r.err).length} bien, ${res.filter(r=>r.err).length} con problemas).</p>`+res.map(r=>`<div class="box" style="margin:0 0 8px;padding:8px 10px"><b>${esc(r.nombre)}</b>${r.err?`<div class="txt-warn">${esc(r.err)}</div>`:`<div class="sm">${r.html}</div>`}</div>`).join(''), 'Carga de Ford');
      const res1 = res.filter(r=>r.selRes); if(res.length===1 && res1.length){ st.selRes = res1[0].selRes; st.sec = 'resumenes'; ctx.setSeccion('resumenes'); }
      render();
    }
    async function procesarFord(rows){
      if(!rows || !rows.length) return {err:'El archivo está vacío.'};
      const hdr = (rows[0]||[]).map(x=>String(x==null?'':x).trim());
      const idx = labels => { for(let i=0;i<hdr.length;i++){ const h = hdr[i].toLowerCase(); if(labels.some(l=>h.includes(l))) return i; } return -1; };
      const entero = v => /^\d+$/.test(String(v==null?'':v).trim());
      const numStr = (v, dec) => { if(v==null||v==='') return ''; const n = Number(v); if(isNaN(n)) return String(v); return String(dec!=null ? Math.round(n*Math.pow(10,dec))/Math.pow(10,dec) : n); };
      const esRetro = idx(['diferencia'])>=0 || idx(['precio anterior','precio atual'])>=0;
      if(esRetro){
        const cRet = idx(['resumen de entrega']), cD = idx(['remito']);
        if(cRet<0) return {err:'No reconocí la columna del número de retroactivo (Resumen de Entrega).'};
        const nums = new Set(); let ign = 0;
        rows.slice(1).forEach(row=>{ if(!row || !row.some(c=>c!=null && String(c).trim()!=='')) return; if(!entero(row[cRet]) || (cD>=0 && !entero(row[cD]))){ ign++; return; } nums.add(String(row[cRet]).trim()); });
        // 1.0.15: los retroactivos nuevos se abren con su empresa de facturación
        const nuevosR = [...nums].filter(x=>!lista(S,'retro').some(y=>y.num===x));
        const empN = nuevosR.length ? await elegirEmpresa(`Retroactivo nuevo de Ford: ${nuevosR.join(', ')}. Elegí la empresa de facturación (o cancelá para dejarlo sin empresa).`) : '';
        const r = await guardar(d=>{ let n = 0; nums.forEach(x=>{ if(!lista(d,'retro').some(y=>y.num===x)){ asegurar(d,'retro',x); if(empN) lista(d,'retro').find(y=>y.num===x).emp = empN; n++; } }); return n; }, 'Subió un Retroactivo de Ford ('+[...nums].join(', ')+')'+(empN?' · '+empN:''));
        if(r===false) return {err:'No se pudo guardar.'};
        return {titulo:'Retroactivo de Ford', html:`Retroactivo procesado.<ul style="margin:6px 0"><li>Nº detectados: <b>${esc([...nums].join(', ')||'(ninguno)')}</b></li><li>Nuevos creados y abiertos: ${r}</li><li>Filas ignoradas (totales u otras): ${ign}</li></ul>El detalle por DRS e importe lo cargás en <b>Retroactivos</b>.`};
      } else {
        const cRes = idx(['resumen de entrega']), cD = idx(['remito']), cU = idx(['precio unit']), cQ = idx(['cantidad']);
        if(cRes<0||cD<0||cU<0||cQ<0) return {err:'No reconocí las columnas del Resumen (necesito Resumen de Entrega, Remito, Precio Unit. y Cantidad).'};
        const r = await guardar(d=>{ const by = new Set(d.drs.map(x=>String(x.drs))); let upd = 0, creados = 0, ign = 0; const sin = [], vistos = new Set();
          rows.slice(1).forEach(row=>{ if(!row || !row.some(c=>c!=null && String(c).trim()!=='')) return;
            if(!entero(row[cRes]) || !entero(row[cD])){ ign++; return; }
            const n = String(row[cD]).trim(), rn = String(row[cRes]).trim();
            if(!vistos.has(rn)){ vistos.add(rn); if(!lista(d,'resumen').some(x=>x.num===rn)){ asegurar(d,'resumen',rn); creados++; } }
            if(!by.has(n)){ sin.push(n); return; }
            const g = reg(d, n); g.resNum = rn; if(row[cU]!=null && row[cU]!=='') g.resUnit = numStr(row[cU], 2); if(row[cQ]!=null && row[cQ]!=='') g.resQty = numStr(row[cQ]); upd++; });
          return {upd, creados, ign, sin, nums:[...vistos]}; }, 'Subió un Resumen de Ford');
        if(!r) return {err:'No se pudo guardar.'};
        return {titulo:'Resumen de Ford', selRes: r.nums.length===1 ? r.nums[0] : null, html:`Resumen procesado (${esc(r.nums.join(', '))}).<ul style="margin:6px 0"><li>DRS actualizados (valor unitario y cantidad): <b>${r.upd}</b></li><li>Resúmenes creados y abiertos: ${r.creados}</li><li>Filas ignoradas (Neto / Bruto / Total u otras): ${r.ign}</li></ul>${r.sin.length?`<div class="txt-warn">DRS del archivo que no están en la base (${r.sin.length}): ${esc(r.sin.slice(0,25).join(', '))}${r.sin.length>25?'…':''}<br>Subilos con "Subir DRS" y volvé a subir el resumen.</div>`:''}`};
      }
    }

    /* ================= RESÚMENES y RETROACTIVOS (misma pantalla, distinto tipo) =================
       Arriba: tablero + lista de números (estado, factura, cantidad de DRS, total). Abajo: los DRS del elegido. */
    function filasLista(t){
      return lista(S, t).map(x=>{ const ds = drsDe(S, t, x.num); const s = stats(S, t, x.num);
        const emps = [...new Set(ds.map(r=>empDe(S, r)).filter(Boolean))], pers = [...new Set(ds.map(periodStr).filter(Boolean))].sort((a,b)=>pKey(a)-pKey(b));
        return {id:x.num, num:x.num, closed:!!x.closed, factura:x.factura||'', c:s.c, s:s.s, emps, pers, emp:x.emp||''}; });
    }
    function defsLista(t){
      return [
        {k:'q', l:`Buscar nº de ${LBL[t].toLowerCase()} o factura…`, tipo:'texto', val:x=>[x.num, x.factura]},
        {k:'estado', l:'Estado', tipo:'lista', sinTodos:true, fijo:true, opciones:[{v:'abiertos', l:'Abiertos (pendientes de facturar)'},{v:'cerrados', l:'Cerrados'},{v:'todos', l:'Todos'}], cumple:(x,v)=> v==='todos' ? true : v==='cerrados' ? x.closed : !x.closed},
        {k:'emp', l:'Empresa', tipo:'lista', opciones:EMPRESAS, cumple:(x,v)=> x.emp ? x.emp===v : x.emps.includes(v)},
        {k:'factura', l:'Sin factura', tipo:'check', cumple:x=> !x.factura}
      ];
    }
    function vLista(t){
      const sk = t==='resumen' ? 'res' : 'ret', gk = t==='resumen' ? 'gRes' : 'gRet', selk = t==='resumen' ? 'selRes' : 'selRet';
      const todas = filasLista(t); const ab = todas.filter(x=>!x.closed), ce = todas.filter(x=>x.closed);
      const sinAsig = S.drs.filter(r=> t==='resumen' ? !getResNum(S, r.drs) : !getRetros(S, r.drs).some(e=>e.num)).length;
      const sinFac = ab.filter(x=>!x.factura).length;
      const kp = [
        {k:'ab', n:ab.length, l:`${t==='resumen'?'Resúmenes':'Retroactivos'} abiertos`, sub:'$ '+fmt(ab.reduce((a,x)=>a+x.s,0)), tono:'brand', icono:'receipt', click:()=>{ st[sk] = {estado:'abiertos'}; vLista(t); }},
        {k:'sf', n:sinFac, l:'Abiertos sin factura', sub:'falta subir o cargar la factura', tono:sinFac?'warn':'ok', icono:'alert', click:()=>{ st[sk] = {estado:'abiertos', factura:true}; vLista(t); }},
        {k:'ce', n:ce.length, l:'Cerrados', sub:'$ '+fmt(ce.reduce((a,x)=>a+x.s,0)), tono:'ok', icono:'check', click:()=>{ st[sk] = {estado:'cerrados'}; vLista(t); }},
        {k:'sa', n:sinAsig, l:`DRS sin ${LBL[t].toLowerCase()}`, sub:'ver en el Buscador', tono:'neutro', icono:'search', click:()=>{ st.bus = t==='resumen' ? {res:'sin'} : {ret:'sin'}; st.sec = 'buscador'; ctx.setSeccion('buscador'); render(); }}];
      const tit = t==='resumen' ? 'Resúmenes' : 'Retroactivos';
      const el = scroll(LS.comp.encabezado(tit, t==='resumen' ? 'Resúmenes de entrega de Ford: sus DRS, valor unitario, cantidad y factura. Elegí uno para ver el detalle.' : 'Retroactivos emitidos: sus DRS, importes y comprobante. Elegí uno para ver el detalle.',
        `${RO()?'':`<button class="btn" data-a="nuevo">${I('plus')} Nuevo ${LBL[t].toLowerCase()}</button>`}<button class="btn" data-a="xls">${I('excel')} Exportar a Excel</button>`) + LS.comp.kpis(kp) + '<div id="flt"></div><div id="tabla"></div><div id="det"></div>', sk);
      LS.comp.cablearKpis(el, kp);
      const bn = el.querySelector('[data-a="nuevo"]'); if(bn) bn.onclick = async ()=>{
        let n, emp = '';
        if(t==='retro'){ // 1.0.15: el retroactivo se abre con su empresa de facturación
          const v = await ui.modal({titulo:'Nuevo retroactivo', html:`<div class="field"><label>Número del retroactivo (solo dígitos)</label><input class="inp" id="nrN"></div>
              <div class="field"><label>Empresa de facturación</label><select class="inp" id="nrE"><option value="">— Elegí la empresa —</option>${EMPRESAS.map(e=>`<option>${esc(e)}</option>`).join('')}</select></div>
              <div class="muted sm">Al agregarle DRS solo se van a ofrecer los de esta empresa.</div>`,
            botones:[{txt:'Cancelar', val:null},{txt:'Crear', primary:true, validar:ov=>{ if(!/^\d+$/.test(ov.querySelector('#nrN').value.trim())){ ui.toast('El número tiene que tener solo dígitos.'); return false; } if(!ov.querySelector('#nrE').value){ ui.toast('Elegí la empresa de facturación.'); return false; } return true; },
              val:ov=>({n:ov.querySelector('#nrN').value.trim(), emp:ov.querySelector('#nrE').value})}]});
          if(!v) return; n = v.n; emp = v.emp;
        } else { n = await ui.pedir(`Número del nuevo ${LBL[t].toLowerCase()} (solo dígitos)`, {titulo:'Nuevo '+LBL[t].toLowerCase()}); if(!n || !n.trim()) return; }
        const r = await guardar(d=>{ const ya = lista(d,t).find(x=>x.num===n.trim()); if(ya){ if(emp && !ya.emp) ya.emp = emp; if(ya.closed){ ya.closed = false; return 'reabierto'; } return 'existe'; } asegurar(d, t, n); if(emp) lista(d,t).find(x=>x.num===n.trim()).emp = emp; return 'nuevo'; }, `Nuevo ${LBL[t].toLowerCase()} ${n.trim()}${emp?' ('+emp+')':''}`);
        if(r==='existe') ui.toast(`El ${LBL[t].toLowerCase()} ${n.trim()} ya existe.`); else if(r==='reabierto') ui.toast(`El ${LBL[t].toLowerCase()} ${n.trim()} estaba cerrado: se reabrió.`);
        if(r){ st[selk] = n.trim(); vLista(t); } };
      el.querySelector('[data-a="xls"]').onclick = ()=>exportarLista(t);
      const cols = colsLista(t);
      const pf = ()=> LS.comp.barraFiltros(el.querySelector('#flt'), {defs:defsLista(t), estado:st[sk], onCambio:txt=>{ if(!st[sk].estado) st[sk].estado = 'abiertos'; pt(); if(!txt) pf(); }});
      const pt = ()=>{ const c = el.querySelector('#tabla'); const filas = LS.comp.aplicarFiltros(filasLista(t), defsLista(t), st[sk]);
        const g = LS.grid.render({id:'drs.'+sk, cols, filas, estado:st[gk], selId:st[selk], vacio:`No hay ${tit.toLowerCase()} con estos filtros.`, ordenClick:true});
        c.innerHTML = `<div class="grid-cuenta muted">${g.vis.length} ${g.vis.length===1?LBL[t].toLowerCase():tit.toLowerCase()} · total $ ${fmt(g.vis.reduce((a,x)=>a+x.s,0))}</div>` + g.html;
        LS.grid.cablear(c, {id:'drs.'+sk, cols, filas, estado:st[gk], repintar:pt, ordenClick:true, onSel:id=>{ st[selk] = id; pt(); detalle(t); }});
        c.querySelectorAll('[data-emp]').forEach(i=>{ i.onclick = e=>e.stopPropagation(); i.onchange = async ()=>{ await guardar(d=>{ const it = lista(d,'retro').find(x=>x.num===i.dataset.emp); if(it) it.emp = i.value; }, `Empresa del retroactivo ${i.dataset.emp}: ${i.value||'sin asignar'}`); pt(); detalle(t); }; });
        c.querySelectorAll('[data-fac]').forEach(i=>{ i.onclick = e=>e.stopPropagation(); i.onchange = async ()=>{ await guardar(d=>{ const it = lista(d,t).find(x=>x.num===i.dataset.fac); if(it) it.factura = i.value.trim(); }, `Factura de ${LBL[t].toLowerCase()} ${i.dataset.fac}: ${i.value.trim()}`); pt(); }; });
        c.querySelectorAll('[data-cerrar]').forEach(b=> b.onclick = async e=>{ e.stopPropagation(); const n = b.dataset.cerrar, cerrar = b.dataset.v==='1';
          await guardar(d=>{ const it = lista(d,t).find(x=>x.num===n); if(it) it.closed = cerrar; }, `${cerrar?'Cerró':'Reabrió'} ${LBL[t].toLowerCase()} ${n}`); pt(); detalle(t); });
        c.querySelectorAll('[data-borrar]').forEach(b=> b.onclick = async e=>{ e.stopPropagation(); const n = b.dataset.borrar; if(!(await ui.confirmar(`¿Eliminar el ${LBL[t].toLowerCase()} <b>${esc(n)}</b> de la lista? No tiene DRS asociados.`, {si:'Eliminar', peligro:true}))) return;
          await guardar(d=>{ d[LISTA[t]] = lista(d,t).filter(x=>x.num!==n); }, `Eliminó ${LBL[t].toLowerCase()} ${n}`); if(st[selk]===n) st[selk] = null; vLista(t); });
      };
      pf(); pt(); detalle(t);
    }
    function colsLista(t){
      const ro = RO();
      return [
        {k:'num', l:'Nº '+LBL[t].toLowerCase(), w:'120px', val:x=>x.num, html:x=>`<b>${esc(x.num)}</b>`},
        {k:'estado', l:'Estado', w:'100px', val:x=>x.closed?'Cerrado':'Abierto', html:x=>LS.comp.estado(x.closed?'Cerrado':'Abierto', x.closed?'ok':'warn')},
        {k:'factura', l: t==='resumen'?'Factura':'Comprobante', w:'190px', val:x=>x.factura, html:x=> ro ? esc(x.factura||'—') : `<input class="inp celda-in" data-fac="${esc(x.num)}" value="${esc(x.factura)}" placeholder="${t==='resumen'?'factura…':'comprobante…'}">`},
        {k:'c', l:'DRS', w:'70px', val:x=>String(x.c)},
        {k:'s', l:'Total $', w:'130px', val:x=>fmt(x.s), html:x=>`<span class="num">${fmt(x.s)}</span>`},
        t==='retro' ? {k:'emps', l:'Empresa de facturación', w:'190px', val:x=>x.emp || x.emps.join(', '), html:x=>{ const dif = x.emp && x.emps.some(e=>e!==x.emp);
            return (ro ? esc(x.emp || x.emps.join(', ') || '—') : `<select class="inp celda-in" data-emp="${esc(x.num)}"><option value="">${esc(x.emps.length ? '('+x.emps.join(', ')+')' : '— elegir —')}</option>${EMPRESAS.map(e=>`<option ${e===x.emp?'selected':''}>${esc(e)}</option>`).join('')}</select>`) + (dif ? `<div><span class="chip t-warn" title="Tiene DRS de otra empresa">DRS de ${esc(x.emps.filter(e=>e!==x.emp).join(', '))}</span></div>` : ''); }}
          : {k:'emps', l:'Empresa', w:'160px', val:x=>x.emps.join(', ')},
        {k:'pers', l:'Períodos de los DRS', w:'230px', val:x=>x.pers.join(', ')},
        {k:'acc', l:'', w: ro?'10px':'190px', nofiltro:true, clase:'col-acc', html:x=> ro ? '' : `<div class="acc">${x.closed?`<button class="btn sm" data-cerrar="${esc(x.num)}" data-v="0">Reabrir</button>`:`<button class="btn sm" data-cerrar="${esc(x.num)}" data-v="1" title="Cerrar cuando ya se facturó">${I('check')} Cerrar</button>`}${x.c===0?`<button class="btn sm" data-borrar="${esc(x.num)}" title="Eliminar (no tiene DRS)">${I('trash')}</button>`:''}</div>`}];
    }
    function colsDetalle(t, num){
      const ro = RO();
      const base = [
        {k:'drs', l:'Nº DRS', w:'95px', val:r=>r.drs, html:r=>`<b>${esc(r.drs)}</b>`},
        {k:'np', l:'Nota de pedido', w:'110px', val:r=>r.np},
        {k:'emp', l:'Empresa', w:'140px', val:r=>empDe(S, r)},
        {k:'serv', l:'Servicio', w:'120px', val:r=>(S.np[r.np]||{}).serv||''},
        {k:'item', l:'Ítem', w:'55px', val:r=>r.item},
        {k:'periodo', l:'Período', w:'120px', val:r=>periodStr(r)}];
      if(t==='resumen') return base.concat([
        {k:'ru', l:'Valor unit.', w:'120px', val:r=>getRU(S, r.drs), html:r=> ro ? esc(getRU(S, r.drs)) : `<input class="inp celda-in num" data-ru="${esc(r.drs)}" value="${esc(getRU(S, r.drs))}" placeholder="$ unit.">`},
        {k:'rq', l:'Cantidad', w:'90px', val:r=>getRQ(S, r.drs), html:r=> ro ? esc(getRQ(S, r.drs)) : `<input class="inp celda-in num" data-rq="${esc(r.drs)}" value="${esc(getRQ(S, r.drs))}" placeholder="cant.">`},
        {k:'tot', l:'Total', w:'120px', val:r=>resTotal(S, r.drs) ? fmt(resTotal(S, r.drs)) : '', html:r=>`<span class="num">${resTotal(S, r.drs) ? fmt(resTotal(S, r.drs)) : '—'}</span>`},
        {k:'obs', l:'Observaciones', w:'150px', val:r=>r.obs||''},
        {k:'acc', l:'', w:'90px', nofiltro:true, html:r=> ro ? '' : `<button class="btn sm" data-quitar="${esc(r.drs)}" title="Quitar este DRS del resumen">Quitar</button>`}]);
      return base.concat([
        {k:'val', l:'Importe', w:'130px', val:r=>(getRetros(S, r.drs).find(e=>e.num===num)||{}).val||'', html:r=>{ const v = (getRetros(S, r.drs).find(e=>e.num===num)||{}).val||''; return ro ? `<span class="num">${esc(v)}</span>` : `<input class="inp celda-in num" data-rv="${esc(r.drs)}" value="${esc(v)}" placeholder="$ importe">`; }},
        {k:'otros', l:'Otros retroactivos del DRS', w:'200px', val:r=>getRetros(S, r.drs).filter(e=>e.num && e.num!==num).map(e=>e.num).join(', ')},
        {k:'obs', l:'Observaciones', w:'150px', val:r=>r.obs||''},
        {k:'acc', l:'', w:'90px', nofiltro:true, html:r=> ro ? '' : `<button class="btn sm" data-quitar="${esc(r.drs)}" title="Quitar este DRS del retroactivo">Quitar</button>`}]);
    }
    function detalle(t){
      const c = root.querySelector('#det'); if(!c) return;
      const selk = t==='resumen' ? 'selRes' : 'selRet', gk = t==='resumen' ? 'gResD' : 'gRetD';
      const num = st[selk]; const it = num && lista(S, t).find(x=>x.num===num);
      if(!it){ c.innerHTML = `<div class="box det-vacio muted">${I('list')} Elegí un ${LBL[t].toLowerCase()} de la lista para ver sus DRS.</div>`; return; }
      const filas = drsDe(S, t, num).map(r=>Object.assign(Object.create(r), {id:r.drs}));
      const s = stats(S, t, num); const cols = colsDetalle(t, num);
      c.innerHTML = `<div class="box det"><div class="sec-head" style="margin-bottom:8px"><div class="sec-tit"><h3 style="margin:0">${LBL[t]} ${esc(num)} ${LS.comp.estado(it.closed?'Cerrado':'Abierto', it.closed?'ok':'warn')}${t==='retro' && empRetro(S, num) ? ' <span class="chip t-info">'+esc(empRetro(S, num))+'</span>' : ''}</h3>
        <div class="muted">${s.c} DRS · total <b>$ ${fmt(s.s)}</b>${it.factura?' · '+(t==='resumen'?'factura':'comprobante')+' <b>'+esc(it.factura)+'</b>':''}</div></div>
        <div class="sec-acc">${RO()?'':`<button class="btn sm" data-a="agregar">${I('plus')} Agregar DRS</button>`}<button class="btn sm" data-a="xlsdet">${I('excel')} Excel de este ${LBL[t].toLowerCase()}</button></div></div><div id="detT"></div></div>`;
      const pt = ()=>{ const g = LS.grid.render({id:'drs.det.'+t, cols, filas, estado:st[gk], vacio:`Todavía no hay DRS asignados a este ${LBL[t].toLowerCase()}.`, ordenClick:true});
        const d = c.querySelector('#detT'); d.innerHTML = g.html; LS.grid.cablear(d, {id:'drs.det.'+t, cols, filas, estado:st[gk], repintar:pt, ordenClick:true});
        d.querySelectorAll('[data-ru],[data-rq]').forEach(i=> i.onchange = async ()=>{ const n = i.dataset.ru || i.dataset.rq, k = i.dataset.ru ? 'resUnit' : 'resQty';
          await guardar(dd=>{ reg(dd, n)[k] = i.value.trim(); }, `DRS ${n}: ${k==='resUnit'?'valor unitario':'cantidad'} ${i.value.trim()}`); vLista(t); });
        d.querySelectorAll('[data-rv]').forEach(i=> i.onchange = async ()=>{ const n = i.dataset.rv;
          await guardar(dd=>{ const e = reg(dd, n).retros.find(x=>x.num===num); if(e) e.val = i.value.trim(); }, `DRS ${n}: importe del retroactivo ${num} ${i.value.trim()}`); vLista(t); });
        d.querySelectorAll('[data-quitar]').forEach(b=> b.onclick = async ()=>{ const n = b.dataset.quitar;
          await guardar(dd=>{ const g2 = reg(dd, n); if(t==='resumen') g2.resNum = ''; else g2.retros = g2.retros.filter(e=>e.num!==num); }, `Quitó el DRS ${n} del ${LBL[t].toLowerCase()} ${num}`); vLista(t); });
      };
      pt();
      const ba = c.querySelector('[data-a="agregar"]'); if(ba) ba.onclick = ()=>agregarDrs(t, num);
      c.querySelector('[data-a="xlsdet"]').onclick = ()=>exportarDetalle(t, num);
    }
    async function agregarDrs(t, num){
      const cand = S.drs.filter(r=> t==='resumen' ? getResNum(S, r.drs)!==num : !getRetros(S, r.drs).some(e=>e.num===num)).sort((a,b)=>pKey(periodStr(a))-pKey(periodStr(b)) || String(a.drs).localeCompare(String(b.drs)));
      const empF = t==='retro' ? empRetro(S, num) : '';
      const fila = r => { const actual = t==='resumen' ? getResNum(S, r.drs) : ''; return `<label class="pick" data-emp="${esc(empDe(S, r))}" data-q="${esc((r.drs+' '+r.np+' '+periodStr(r)+' '+empDe(S, r)).toLowerCase())}"><input type="checkbox" value="${esc(r.drs)}"> <b>${esc(r.drs)}</b> <span class="muted">NP ${esc(r.np)} · ítem ${esc(r.item)} · ${esc(periodStr(r))} · ${esc(empDe(S, r)||'sin empresa')}</span>${actual?` <span class="chip t-warn">hoy en ${esc(actual)}</span>`:''}</label>`; };
      const sel = await ui.modal({titulo:`Agregar DRS al ${LBL[t].toLowerCase()} ${num}`, lg:true, html:`<div class="row" style="margin-bottom:8px"><input class="inp" id="pq" placeholder="Filtrar por DRS, nota de pedido, período o empresa…" style="flex:1"><label class="chk"><input type="checkbox" id="psin" checked> Solo los que no tienen ${LBL[t].toLowerCase()}</label>${empF?`<label class="chk"><input type="checkbox" id="pemp" checked> Solo DRS de <b>${esc(empF)}</b></label>`:''}</div>
        ${t==='retro' && !empF ? `<div class="banner warn" style="border-radius:6px;margin-bottom:8px">${I('alert')}<span class="grow">Este retroactivo no tiene empresa de facturación: se muestran los DRS de todas las empresas. Elegila en la columna "Empresa de facturación" de la lista.</span></div>` : ''}
        <div class="pick-list" id="pl">${cand.map(fila).join('') || '<div class="empty">No hay DRS para agregar.</div>'}</div><div class="muted sm" id="pn" style="margin-top:6px"></div>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Agregar los marcados', primary:true, val:ov=>Array.from(ov.querySelectorAll('#pl input:checked')).map(i=>i.value)}],
        onOpen: ov=>{ const q = ov.querySelector('#pq'), sin = ov.querySelector('#psin'), n = ov.querySelector('#pn'), pe = ov.querySelector('#pemp');
          const tiene = d => t==='resumen' ? !!getResNum(S, d) : getRetros(S, d).some(e=>e.num);
          const f = ()=>{ const v = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean); let vis = 0; ov.querySelectorAll('.pick').forEach(l=>{ const d = l.querySelector('input').value; const ok = v.every(x=>l.dataset.q.includes(x)) && (!sin.checked || !tiene(d)) && (!pe || !pe.checked || l.dataset.emp===empF); l.style.display = ok ? '' : 'none'; if(ok) vis++; }); n.textContent = vis+' DRS en la lista · '+ov.querySelectorAll('#pl input:checked').length+' marcados'; };
          q.oninput = f; sin.onchange = f; if(pe) pe.onchange = f; ov.querySelector('#pl').onchange = f; f(); }});
      if(!sel || !sel.length) return;
      await guardar(d=>{ sel.forEach(n=>{ const g = reg(d, n); if(t==='resumen') g.resNum = num; else if(!g.retros.some(e=>e.num===num)) g.retros.push({num, val:''}); }); }, `Agregó ${sel.length} DRS al ${LBL[t].toLowerCase()} ${num}`);
      ui.toast(sel.length+' DRS agregados'+(t==='retro'?'. Cargá el importe de cada uno en la tabla.':'.'));
      vLista(t);
    }

    /* ================= BUSCADOR ================= */
    function defsBus(){
      const pers = [...new Set(S.drs.map(periodStr).filter(Boolean))].sort((a,b)=>pKey(b)-pKey(a));
      return [
        {k:'q', l:'Buscar DRS, nota de pedido, ítem, resumen, retroactivo, factura…', tipo:'texto', val:r=>[r.drs, r.np, 'item '+r.item, getResNum(S, r.drs), ...getRetros(S, r.drs).map(e=>e.num), facturaDe(S,'resumen',getResNum(S, r.drs)), r.obs, r.archivo]},
        {k:'fecha', l:'Fecha', tipo:'fecha', val:r=>r.fecha||''},
        {k:'emp', l:'Empresa', tipo:'lista', opciones:EMPRESAS, cumple:(r,v)=>empDe(S, r)===v},
        {k:'per', l:'Período del DRS', tipo:'lista', opciones:pers, cumple:(r,v)=>periodStr(r)===v},
        {k:'serv', l:'Servicio', tipo:'lista', opciones:SERVICIOS, cumple:(r,v)=>(S.np[r.np]||{}).serv===v},
        {k:'estado', l:'Estado', tipo:'lista', opciones:[{v:'Pendiente', l:'Pendientes de facturar'},{v:'Completado', l:'Completados'}], cumple:(r,v)=>estadoDrs(S, r)===v},
        {k:'res', l:'Resumen', tipo:'lista', opciones:[{v:'con', l:'Con resumen'},{v:'sin', l:'Sin resumen'}], cumple:(r,v)=> v==='con' ? !!getResNum(S, r.drs) : !getResNum(S, r.drs)},
        {k:'ret', l:'Retroactivo', tipo:'lista', opciones:[{v:'con', l:'Con retroactivo'},{v:'sin', l:'Sin retroactivo'}], cumple:(r,v)=>{ const x = getRetros(S, r.drs).some(e=>e.num); return v==='con' ? x : !x; }}
      ];
    }
    const retTot = r => getRetros(S, r.drs).filter(e=>e.num).reduce((a,e)=>a+numOf(e.val),0);
    function colsBus(){
      return [
        {k:'drs', l:'Nº DRS', w:'90px', val:r=>r.drs, html:r=>`<b>${esc(r.drs)}</b>`},
        {k:'np', l:'Nota de pedido', w:'105px', val:r=>r.np},
        {k:'emp', l:'Empresa', w:'135px', val:r=>empDe(S, r)},
        {k:'serv', l:'Servicio', w:'110px', val:r=>(S.np[r.np]||{}).serv||''},
        {k:'item', l:'Ítem', w:'50px', val:r=>r.item},
        {k:'periodo', l:'Período', w:'115px', val:r=>periodStr(r), html:r=>esc(periodStr(r))},
        {k:'fecha', l:'Fecha', w:'90px', val:r=>fmtF(r.fecha)},
        {k:'res', l:'Resumen', w:'95px', val:r=>getResNum(S, r.drs)},
        {k:'ru', l:'Valor unit.', w:'100px', val:r=>getRU(S, r.drs) ? fmt(numOf(getRU(S, r.drs))) : ''},
        {k:'rq', l:'Cant.', w:'60px', val:r=>getRQ(S, r.drs)},
        {k:'rt', l:'Total resumen', w:'115px', val:r=>resTotal(S, r.drs) ? fmt(resTotal(S, r.drs)) : ''},
        {k:'ret', l:'Retroactivos', w:'150px', val:r=>getRetros(S, r.drs).filter(e=>e.num).map(e=>e.num).join(', ')},
        {k:'rett', l:'Total retro.', w:'110px', val:r=>retTot(r) ? fmt(retTot(r)) : ''},
        {k:'estado', l:'Estado', w:'105px', val:r=>estadoDrs(S, r), html:r=>LS.comp.estado(estadoDrs(S, r), estadoDrs(S, r)==='Completado'?'ok':'warn')},
        {k:'obs', l:'Observaciones', w:'140px', val:r=>r.obs||''}];
    }
    const filasBus = () => LS.comp.aplicarFiltros(S.drs.map(r=>Object.assign(Object.create(r), {id:r.drs})), defsBus(), st.bus);
    function vBuscador(){
      const el = scroll(LS.comp.encabezado('Buscador de DRS', 'Combiná los filtros: el Excel exporta exactamente lo que ves, con los filtros aplicados en una hoja aparte. Tocá un DRS para ver o editar su detalle.',
        `<button class="btn" data-a="xls">${I('excel')} Exportar resultado</button><button class="btn" data-a="todo">${I('download')} Exportar toda la base</button>`) + '<div id="flt"></div><div id="tabla"></div>', 'bus');
      el.querySelector('[data-a="xls"]').onclick = exportarBuscador;
      el.querySelector('[data-a="todo"]').onclick = exportarTodo;
      const cols = colsBus();
      const pf = ()=> LS.comp.barraFiltros(el.querySelector('#flt'), {defs:defsBus(), estado:st.bus, onCambio:txt=>{ pt(); if(!txt) pf(); }});
      const pt = ()=>{ const c = el.querySelector('#tabla'); const filas = filasBus();
        const g = LS.grid.render({id:'drs.bus', cols, filas, estado:st.gBus, vacio:'Ningún DRS coincide con los filtros.', ordenClick:true});
        const tr = g.vis.reduce((a,r)=>a+resTotal(S, r.drs),0), tt = g.vis.reduce((a,r)=>a+retTot(r),0);
        c.innerHTML = `<div class="grid-cuenta muted">${g.vis.length} DRS de ${S.drs.length} · total resúmenes $ ${fmt(tr)} · total retroactivos $ ${fmt(tt)}${g.vis.some(r=>!r.fecha) && st.bus.fecha ? ' · <span class="txt-warn">los DRS sin fecha no entran en el filtro de fecha</span>' : ''}</div>` + g.html;
        LS.grid.cablear(c, {id:'drs.bus', cols, filas, estado:st.gBus, repintar:pt, ordenClick:true, onSel:id=>editarDrs(id)}); };
      pf(); pt();
    }

    /* ---------- Detalle / edición de un DRS ---------- */
    async function editarDrs(n){
      const r = S.drs.find(x=>x.drs===n); if(!r) return;
      const ro = RO(); const dis = ro ? 'disabled' : '';
      const g = S.registros[n] || {retros:[], resNum:'', resUnit:'', resQty:''};
      const abiertos = t => lista(S, t).filter(x=>!x.closed || x.num===(t==='resumen'?g.resNum:'') || (t==='retro' && (g.retros||[]).some(e=>e.num===x.num))).map(x=>x.num);
      const optRes = cur => `<option value="">—</option>${abiertos('resumen').map(x=>`<option ${x===cur?'selected':''}>${esc(x)}</option>`).join('')}`;
      // 1.0.15: solo los retroactivos abiertos de la empresa del DRS (y los que no tienen empresa, aclarado)
      const empR = empDe(S, r);
      const retOps = cur => abiertos('retro').filter(x=> x===cur || !empR || !empRetro(S, x) || empRetro(S, x)===empR);
      const filaRet = (e, i) => `<div class="row ret-fila" data-i="${i}"><select class="inp" data-rn ${dis} style="width:210px"><option value="">—</option>${retOps(e.num).map(x=>`<option value="${esc(x)}" ${x===e.num?'selected':''}>${esc(x)}${empRetro(S, x) ? '' : ' (sin empresa)'}${empR && empRetro(S, x) && empRetro(S, x)!==empR ? ' ('+esc(empRetro(S, x))+')' : ''}</option>`).join('')}</select><input class="inp" data-rvv value="${esc(e.val||'')}" placeholder="$ importe" style="width:140px" ${dis}>${ro?'':`<button class="btn sm" data-rx title="Quitar">${I('x')}</button>`}${e.num && facturaDe(S,'retro',e.num) ? `<span class="chip t-info">${esc(facturaDe(S,'retro',e.num))}</span>` : ''}</div>`;
      const v = await ui.modal({titulo:'DRS '+n, lg:true, avisarCambios:true, html:`<div class="grid3">
          <div class="field"><label>Nº DRS</label><input class="inp" id="eD" value="${esc(r.drs)}" ${dis}></div>
          <div class="field"><label>Nota de pedido</label><input class="inp" id="eN" value="${esc(r.np)}" ${dis}></div>
          <div class="field"><label>Ítem</label><input class="inp" id="eI" value="${esc(r.item)}" ${dis}></div>
          <div class="field"><label>Período</label><select class="inp" id="eP" ${dis}>${MESES.map(m=>`<option ${m===r.periodo?'selected':''}>${m}</option>`).join('')}</select></div>
          <div class="field"><label>Año</label><input class="inp" id="eA" value="${esc(r.anio||'')}" ${dis}></div>
          <div class="field"><label>Fecha del archivo</label><input class="inp" type="date" id="eF" value="${esc(r.fecha||'')}" ${dis}></div></div>
        <div class="field"><label>Observaciones</label><input class="inp" id="eO" value="${esc(r.obs||'')}" ${dis}></div>
        <div class="muted sm" style="margin-bottom:10px">Empresa: <b>${esc(empDe(S, r)||'sin asignar')}</b> · servicio: ${esc((S.np[r.np]||{}).serv||'—')} · archivo: ${esc(r.archivo||'—')} · carpeta: ${esc(r.carpeta||'—')}</div>
        <div class="split"><div class="box"><h3>${I('receipt')} Resumen</h3><div class="field"><label>Nº de resumen</label><select class="inp" id="eR" ${dis}>${optRes(g.resNum)}</select></div>
          <div class="grid2"><div class="field"><label>Valor unitario</label><input class="inp" id="eU" value="${esc(g.resUnit||'')}" ${dis}></div><div class="field"><label>Cantidad</label><input class="inp" id="eQ" value="${esc(g.resQty||'')}" ${dis}></div></div>
          <div class="muted sm" id="eT"></div></div>
          <div class="box"><h3>${I('history')} Retroactivos</h3><div id="eRL">${(g.retros||[]).map(filaRet).join('') || ''}</div>${ro?'':`<button class="btn sm" id="eRA">${I('plus')} Agregar retroactivo</button>`}</div></div>`,
        botones: ro ? [{txt:'Cerrar', val:null, primary:true}] : [{txt:'Eliminar DRS', val:'del', danger:true},{txt:'Cancelar', val:null},{txt:'Guardar', primary:true,
          validar: ov=>{ const nd = ov.querySelector('#eD').value.trim(); if(!nd){ ui.toast('El Nº DRS no puede quedar vacío.'); return false; } if(nd!==n && S.drs.some(x=>x.drs===nd)){ ui.toast('Ya existe otro DRS con el número '+nd+'.'); return false; } return true; },
          val: ov=>({drs:ov.querySelector('#eD').value.trim(), np:ov.querySelector('#eN').value.trim(), item:ov.querySelector('#eI').value.trim(), periodo:ov.querySelector('#eP').value, anio:ov.querySelector('#eA').value.trim(), fecha:ov.querySelector('#eF').value, obs:ov.querySelector('#eO').value.trim(),
            resNum:ov.querySelector('#eR').value, resUnit:ov.querySelector('#eU').value.trim(), resQty:ov.querySelector('#eQ').value.trim(),
            retros:Array.from(ov.querySelectorAll('.ret-fila')).map(f=>({num:f.querySelector('[data-rn]').value, val:f.querySelector('[data-rvv]').value.trim()})).filter(e=>e.num || e.val)})}],
        onOpen: ov=>{ const tot = ()=>{ const u = ov.querySelector('#eU').value, q = ov.querySelector('#eQ').value; ov.querySelector('#eT').textContent = (u && q) ? 'Total del resumen: $ '+fmt(numOf(u)*numOf(q)) : ''; };
          ov.querySelector('#eU').oninput = tot; ov.querySelector('#eQ').oninput = tot; tot();
          const cab = ()=> ov.querySelectorAll('[data-rx]').forEach(b=> b.onclick = ()=>{ b.closest('.ret-fila').remove(); });
          cab(); const a = ov.querySelector('#eRA'); if(a) a.onclick = ()=>{ ov.querySelector('#eRL').insertAdjacentHTML('beforeend', filaRet({num:'', val:''}, Date.now())); cab(); }; }});
      if(!v) return;
      if(v==='del'){
        if(!(await ui.confirmar(`¿Eliminar el DRS <b>${esc(n)}</b> y sus datos de resumen y retroactivos?<br><span class="muted">Se puede volver atrás con "Deshacer" mientras no cierres el programa.</span>`, {si:'Eliminar', peligro:true}))) return;
        await guardar(d=>{ d.drs = d.drs.filter(x=>x.drs!==n); delete d.registros[n]; }, 'Eliminó el DRS '+n); render(); return;
      }
      await guardar(d=>{ const x = d.drs.find(y=>y.drs===n); if(!x) return;
        if(v.drs!==n && d.registros[n]){ d.registros[v.drs] = d.registros[n]; delete d.registros[n]; }
        Object.assign(x, {drs:v.drs, np:v.np, item:v.item, periodo:v.periodo, anio:v.anio, fecha:v.fecha, obs:v.obs});
        const g2 = reg(d, v.drs); g2.resNum = v.resNum; g2.resUnit = v.resUnit; g2.resQty = v.resQty; g2.retros = v.retros; }, 'Editó el DRS '+n);
      render();
    }

    /* ================= NOTAS DE PEDIDO =================
       Empresa (con cambios a partir de un período), servicio, código interno y estado abierta / cerrada (1.0.4). */
    function vNotas(){
      st.np = st.np || {estado:'abiertas'};
      const nps = [...new Set(S.drs.map(r=>r.np).filter(Boolean))];
      const filas = nps.map(np=>{ const n = S.np[np]||{}; const ds = S.drs.filter(r=>r.np===np); const pers = ds.map(perKey).filter(k=>!/-00$/.test(k)).sort();
        return {id:np, np, emp:n.emp||'', hist:n.empHist||null, serv:n.serv||'', cod:n.cod||'', cerrada:!!n.cerrada, fechaCierre:n.fechaCierre||'', n:ds.length, desde:pers[0]||'', hasta:pers[pers.length-1]||''}; });
      const ro = RO(); const opt = (arr, v) => `<option value="">—</option>`+arr.map(o=>`<option ${o===v?'selected':''}>${esc(o)}</option>`).join('');
      const histTxt = x => (x.hist && x.hist.length>1) ? `<div class="muted sm">${x.hist.map(h=>`${esc(h.emp||'—')} desde ${esc(perLabel(h.desde))}`).join(' → ')} <a href="#" class="link" data-hist="${esc(x.np)}">historial</a></div>` : '';
      const defs = [
        {k:'q', l:'Buscar nota de pedido o código…', tipo:'texto', val:x=>[x.np, x.cod]},
        {k:'estado', l:'Estado', tipo:'lista', sinTodos:true, fijo:true, opciones:[{v:'abiertas', l:'Abiertas'},{v:'cerradas', l:'Cerradas'},{v:'todas', l:'Todas'}], cumple:(x,v)=> v==='todas' ? true : v==='cerradas' ? x.cerrada : !x.cerrada},
        {k:'emp', l:'Empresa', tipo:'lista', opciones:EMPRESAS, cumple:(x,v)=> x.emp===v || (x.hist||[]).some(h=>h.emp===v)}];
      const cols = [
        {k:'np', l:'Nota de pedido', w:'120px', val:x=>x.np, html:x=>`<b>${esc(x.np)}</b>`},
        {k:'estado', l:'Estado', w:'110px', val:x=>x.cerrada?'Cerrada':'Abierta', html:x=>LS.comp.estado(x.cerrada?'Cerrada':'Abierta', x.cerrada?'neutro':'ok')+(x.fechaCierre?`<div class="muted sm">${ui.fecha(x.fechaCierre)}</div>`:'')},
        {k:'emp', l:'Empresa facturadora (actual)', w:'240px', val:x=>x.emp, html:x=> (ro ? esc(x.emp||'—') : `<select class="inp celda-in" data-emp="${esc(x.np)}">${opt(EMPRESAS, x.emp)}</select>`) + histTxt(x)},
        {k:'serv', l:'Tipo de servicio', w:'160px', val:x=>x.serv, html:x=> ro ? esc(x.serv||'—') : `<select class="inp celda-in" data-np="${esc(x.np)}" data-f="serv">${opt(SERVICIOS, x.serv)}</select>`},
        {k:'cod', l:'Código interno', w:'150px', val:x=>x.cod, html:x=> ro ? esc(x.cod||'—') : `<input class="inp celda-in" data-np="${esc(x.np)}" data-f="cod" value="${esc(x.cod)}" placeholder="código interno">`},
        {k:'n', l:'DRS', w:'60px', val:x=>String(x.n)},
        {k:'per', l:'Períodos', w:'190px', val:x=>x.desde ? perLabel(x.desde)+(x.hasta!==x.desde?' a '+perLabel(x.hasta):'') : ''},
        {k:'acc', l:'', w:'110px', nofiltro:true, clase:'col-acc', html:x=> ro ? '' : `<button class="btn sm" data-cerrar="${esc(x.np)}" data-v="${x.cerrada?0:1}">${x.cerrada?'Reabrir':I('check')+' Cerrar'}</button>`}];
      const el = scroll(LS.comp.encabezado('Notas de pedido', 'Empresa, servicio y código interno de cada nota de pedido. Si una NP pasa a otra empresa, el cambio rige desde un período: los DRS anteriores conservan la empresa que tenían. Las NP terminadas se cierran.') + '<div id="flt"></div><div id="tabla"></div>', 'np');
      const pf = ()=> LS.comp.barraFiltros(el.querySelector('#flt'), {defs, estado:st.np, onCambio:txt=>{ if(!st.np.estado) st.np.estado = 'abiertas'; pt(); if(!txt) pf(); }});
      const pt = ()=>{ const c = el.querySelector('#tabla'); const vis = LS.comp.aplicarFiltros(filas, defs, st.np);
        const g = LS.grid.render({id:'drs.np', cols, filas:vis, estado:st.gNp, vacio:'No hay notas de pedido con estos filtros.', ordenClick:true});
        c.innerHTML = `<div class="grid-cuenta muted">${g.vis.length} nota${g.vis.length===1?'':'s'} de pedido</div>` + g.html;
        LS.grid.cablear(c, {id:'drs.np', cols, filas:vis, estado:st.gNp, repintar:pt, ordenClick:true});
        c.querySelectorAll('[data-np]').forEach(i=> i.onchange = async ()=>{ const np = i.dataset.np, f = i.dataset.f, v = i.value.trim();
          await guardar(d=>{ d.np[np] = d.np[np] || {emp:'', serv:'', cod:''}; d.np[np][f] = v; }, `NP ${np}: ${f==='serv'?'servicio':'código'} ${v}`); const x = filas.find(y=>y.np===np); if(x) x[f] = v; });
        c.querySelectorAll('[data-emp]').forEach(i=> i.onchange = async ()=>{ const ok = await cambiarEmpresa(i.dataset.emp, i.value); if(!ok) i.value = (S.np[i.dataset.emp]||{}).emp||''; else vNotas(); });
        c.querySelectorAll('[data-hist]').forEach(a=> a.onclick = e=>{ e.preventDefault(); historialEmp(a.dataset.hist); });
        c.querySelectorAll('[data-cerrar]').forEach(b=> b.onclick = async ()=>{ const np = b.dataset.cerrar, cerrar = b.dataset.v==='1';
          if(cerrar && !(await ui.confirmar(`¿Cerrar la nota de pedido <b>${esc(np)}</b>?<br><span class="muted">Sus DRS se conservan. Si llega un DRS nuevo de esta NP, el programa avisa. Se puede reabrir.</span>`, {si:'Cerrar NP'}))) return;
          await guardar(d=>{ d.np[np] = d.np[np] || {emp:'', serv:'', cod:''}; d.np[np].cerrada = cerrar; d.np[np].fechaCierre = cerrar ? ui.hoy() : ''; }, `${cerrar?'Cerró':'Reabrió'} la NP ${np}`); vNotas(); });
      };
      pf(); pt();
    }
    async function cambiarEmpresa(np, emp){
      const n = S.np[np] || {}; const actual = n.emp || '';
      if(!actual || !emp){ return guardar(d=>{ d.np[np] = d.np[np] || {emp:'', serv:'', cod:''}; d.np[np].emp = emp; delete d.np[np].empHist; }, `NP ${np}: empresa ${emp||'(sin empresa)'}`); }
      const pers = [...new Set(S.drs.filter(r=>r.np===np).map(perKey).filter(k=>!/-00$/.test(k)))].sort();
      const hoy = ui.hoy().slice(0,7); const sig = k => { let [y,m] = k.split('-').map(Number); m++; if(m>12){ m=1; y++; } return y+'-'+String(m).padStart(2,'0'); };
      const opciones = [...new Set(pers.concat([hoy, sig(hoy)]))].sort();
      const def = pers.length ? sig(pers[pers.length-1]) : hoy;
      const v = await ui.modal({titulo:'Cambiar la empresa de la NP '+np, html:`<p style="margin-top:0">De <b>${esc(actual)}</b> a <b>${esc(emp)}</b>.</p>
        <label class="chk" style="display:flex;align-items:flex-start;gap:6px;margin-bottom:8px"><input type="radio" name="mE" value="desde" checked> <span>La NP <b>pasó a otra empresa</b>: la nueva rige a partir de
          <select class="inp" id="mD" style="width:auto;margin-left:4px">${opciones.map(k=>`<option value="${k}" ${k===def?'selected':''}>${esc(perLabel(k))}</option>`).join('')}</select><br><span class="muted sm">Los DRS de períodos anteriores conservan ${esc(actual)}.</span></span></label>
        <label class="chk" style="display:flex;align-items:flex-start;gap:6px"><input type="radio" name="mE" value="todo"> <span>Estaba <b>mal cargada</b>: corregir la empresa para todos los DRS de esta NP.</span></label>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Guardar', primary:true, val:ov=>({modo:ov.querySelector('input[name=mE]:checked').value, desde:ov.querySelector('#mD').value})}]});
      if(!v) return false;
      if(v.modo==='todo') return guardar(d=>{ d.np[np].emp = emp; delete d.np[np].empHist; }, `NP ${np}: empresa corregida a ${emp} (todos los DRS)`);
      return guardar(d=>{ empDesde(d, np, emp, v.desde); }, `NP ${np}: pasa a ${emp} desde ${perLabel(v.desde)}`);
    }
    async function historialEmp(np){
      const n = S.np[np] || {}; const h = (n.empHist||[]).slice().sort((a,b)=>a.desde.localeCompare(b.desde));
      const r = await ui.modal({titulo:'Empresa de la NP '+np, html:`<table class="grid"><thead><tr><th>Desde</th><th>Empresa</th><th>DRS</th><th></th></tr></thead><tbody>${h.map((x,i)=>{ const hasta = h[i+1] ? h[i+1].desde : '9999-99'; const nd = S.drs.filter(r=>r.np===np && perKey(r)>=x.desde && perKey(r)<hasta).length;
          return `<tr><td>${esc(perLabel(x.desde))}</td><td>${esc(x.emp||'—')}</td><td>${nd}</td><td>${!RO() && i>0 ? `<button class="btn sm" data-q="${esc(x.desde)}" title="Quitar este cambio">${I('trash')}</button>`:''}</td></tr>`; }).join('')}</tbody></table>`,
        botones:[{txt:'Cerrar', val:null, primary:true}], onOpen:(ov, close)=> ov.querySelectorAll('[data-q]').forEach(b=> b.onclick = async ()=>{
          await guardar(d=>{ const x = d.np[np]; x.empHist = x.empHist.filter(y=>y.desde!==b.dataset.q); if(x.empHist.length<=1){ x.emp = (x.empHist[0]||{}).emp||x.emp; delete x.empHist; } else x.emp = x.empHist[x.empHist.length-1].emp; }, `NP ${np}: quitó el cambio de empresa desde ${perLabel(b.dataset.q)}`);
          close(null); vNotas(); })});
      return r;
    }

    /* ================= EXCEL ================= */
    const colsXlsDrs = [
      {l:'Nº DRS', w:11, v:r=>Number(r.drs)||r.drs}, {l:'Nota de pedido', w:13, v:r=>Number(r.np)||r.np}, {l:'Empresa', w:18, v:r=>empDe(S, r)}, {l:'Servicio', w:15, v:r=>(S.np[r.np]||{}).serv||''},
      {l:'Código interno', w:14, v:r=>(S.np[r.np]||{}).cod||''}, {l:'Ítem', w:6, v:r=>Number(r.item)||r.item}, {l:'Período', w:15, v:r=>periodStr(r)}, {l:'Fecha', w:11, v:r=>fmtF(r.fecha)},
      {l:'Cant. retroactivos', w:10, v:r=>getRetros(S, r.drs).filter(e=>e.num).length}, {l:'Total retroactivos', w:16, v:r=>retTot(r) ? {v:retTot(r), fmt:'$'} : ''},
      {l:'Retroactivos (detalle)', w:30, v:r=>getRetros(S, r.drs).filter(e=>e.num).map(e=>e.num+': '+(e.val||'0')).join(' | ')},
      {l:'Resumen', w:11, v:r=>getResNum(S, r.drs)}, {l:'Estado resumen', w:12, v:r=>getResNum(S, r.drs) ? (isClosed(S,'resumen',getResNum(S, r.drs))?'Cerrado':'Abierto') : ''},
      {l:'Valor unitario', w:14, v:r=>getRU(S, r.drs)!=='' ? {v:numOf(getRU(S, r.drs)), fmt:'$'} : ''}, {l:'Cantidad', w:9, v:r=>getRQ(S, r.drs)!=='' ? numOf(getRQ(S, r.drs)) : ''},
      {l:'Total resumen', w:15, v:r=>resTotal(S, r.drs) ? {v:resTotal(S, r.drs), fmt:'$'} : ''}, {l:'Factura resumen', w:17, v:r=>facturaDe(S,'resumen',getResNum(S, r.drs))},
      {l:'Estado', w:12, v:r=>estadoDrs(S, r)}, {l:'Observaciones', w:22, v:r=>r.obs||''}, {l:'Carpeta', w:16, v:r=>r.carpeta||''}, {l:'Archivo', w:32, v:r=>r.archivo||''}];
    const colsXlsRet = [
      {l:'Nº DRS', w:11, v:x=>Number(x.r.drs)||x.r.drs}, {l:'Nota de pedido', w:13, v:x=>Number(x.r.np)||x.r.np}, {l:'Empresa', w:18, v:x=>empDe(S, x.r)}, {l:'Ítem', w:6, v:x=>Number(x.r.item)||x.r.item},
      {l:'Período', w:15, v:x=>periodStr(x.r)}, {l:'Nº retroactivo', w:13, v:x=>x.e.num}, {l:'Estado', w:10, v:x=>isClosed(S,'retro',x.e.num)?'Cerrado':'Abierto'}, {l:'Importe', w:15, v:x=>x.e.val!=='' && x.e.val!=null ? {v:numOf(x.e.val), fmt:'$'} : ''}, {l:'Comprobante', w:17, v:x=>facturaDe(S,'retro',x.e.num)}];
    const retDe = rows => { const out = []; rows.forEach(r=> getRetros(S, r.drs).forEach(e=>{ if(e.num) out.push({r, e}); })); return out.sort((a,b)=>String(a.e.num).localeCompare(String(b.e.num)) || (Number(a.r.drs)-Number(b.r.drs))); };
    const colsXlsLista = t => [{l:'Nº '+LBL[t].toLowerCase(), w:14, v:x=>Number(x.num)||x.num}, {l:'Estado', w:10, v:x=>x.closed?'Cerrado':'Abierto'}, {l:t==='resumen'?'Factura':'Comprobante', w:18, v:x=>x.factura},
      {l:'Cant. DRS', w:10, v:x=>x.c}, {l:'Total $', w:16, v:x=>({v:x.s, fmt:'$'})}, {l:'Empresa', w:22, v:x=>x.emps.join(', ')}, {l:'Períodos', w:30, v:x=>x.pers.join(', ')}, {l:'DRS asociados', w:60, v:x=>drsDe(S, t, x.num).map(r=>r.drs).join(', ')}];
    const ordDrs = rows => rows.slice().sort((a,b)=>(pKey(periodStr(a))-pKey(periodStr(b))) || (Number(a.np)-Number(b.np)) || (Number(a.item)-Number(b.item)));
    function exportarBuscador(){
      const rows = ordDrs(LS.grid.render({cols:colsBus(), filas:filasBus(), estado:st.gBus}).vis);
      if(!rows.length) return ui.toast('No hay DRS para exportar con estos filtros.');
      LS.comp.exportar({archivo:'DRS filtrados '+ui.hoy()+'.xlsx', hoja:'DRS', cols:colsXlsDrs, filas:rows, filtros:LS.comp.describirFiltros(defsBus(), st.bus, colsBus(), st.gBus), extras:[{hoja:'Retroactivos', cols:colsXlsRet, filas:retDe(rows)}]});
    }
    function exportarTodo(){
      const rows = ordDrs(S.drs);
      LS.comp.exportar({archivo:'Base DRS completa '+ui.hoy()+'.xlsx', hoja:'DRS', cols:colsXlsDrs, filas:rows, filtros:[['(sin filtros)', 'Toda la base']], extras:[{hoja:'Retroactivos', cols:colsXlsRet, filas:retDe(rows)},
        {hoja:'Lista de resúmenes', cols:colsXlsLista('resumen'), filas:filasLista('resumen')}, {hoja:'Lista de retroactivos', cols:colsXlsLista('retro'), filas:filasLista('retro')}]});
    }
    function exportarLista(t){
      const sk = t==='resumen' ? 'res' : 'ret', gk = t==='resumen' ? 'gRes' : 'gRet';
      const filas = LS.grid.render({cols:colsLista(t), filas:LS.comp.aplicarFiltros(filasLista(t), defsLista(t), st[sk]), estado:st[gk]}).vis;
      if(!filas.length) return ui.toast('No hay nada para exportar con estos filtros.');
      const rows = ordDrs(S.drs.filter(r=> filas.some(x=> t==='resumen' ? getResNum(S, r.drs)===x.num : getRetros(S, r.drs).some(e=>e.num===x.num))));
      LS.comp.exportar({archivo:(t==='resumen'?'Resumenes':'Retroactivos')+' DRS '+ui.hoy()+'.xlsx', hoja:t==='resumen'?'Resúmenes':'Retroactivos', cols:colsXlsLista(t), filas,
        filtros:LS.comp.describirFiltros(defsLista(t), st[sk], colsLista(t), st[gk]), extras: t==='resumen' ? [{hoja:'DRS', cols:colsXlsDrs, filas:rows}] : [{hoja:'DRS', cols:colsXlsRet, filas:retDe(rows).filter(x=>filas.some(f=>f.num===x.e.num))}]});
    }
    function exportarDetalle(t, num){
      const rows = ordDrs(drsDe(S, t, num));
      LS.comp.exportar({archivo:LBL[t]+' '+num+'.xlsx', hoja:LBL[t]+' '+num, cols: t==='resumen' ? colsXlsDrs : colsXlsRet, filas: t==='resumen' ? rows : retDe(rows).filter(x=>x.e.num===num),
        filtros:[[LBL[t], num], ['Estado', isClosed(S,t,num)?'Cerrado':'Abierto'], [t==='resumen'?'Factura':'Comprobante', facturaDe(S,t,num)||'—']]});
    }

    /* ================= MONTAJE ================= */
    function render(){ if(!S) return; ({resumenes:()=>vLista('resumen'), retroactivos:()=>vLista('retro'), buscador:vBuscador, notas:vNotas, rellenar:()=>LS.drsRellenar.vista(root, ctx, {agregarDrs:altaDesdeRellenar})}[st.sec] || (()=>vLista('resumen')))(); }
    let listo = false;
    (async ()=>{ root.innerHTML = '<div class="scroll"><div class="empty">Cargando…</div></div>'; listo = await cargar(); if(listo){ render(); ctx.refrescarMenu(); } })();
    return {
      seccion(s){ st.sec = s || 'resumenes'; if(listo) render(); },
      acciones(){ if(!S) return [];
        return [
          {grupo:'Cargar', items:[{txt:'Subir DRS', icono:'folder', nivel:'editar', run:subirDrs}, {txt:'Subir facturas', icono:'receipt', nivel:'editar', run:subirFacturas}, {txt:'Subir Resumen Ford', icono:'upload', nivel:'editar', run:subirFord}]},
          {grupo:'Exportar', items:[{txt:'Excel de la vista', icono:'excel', run:()=> st.sec==='buscador' ? exportarBuscador() : st.sec==='retroactivos' ? exportarLista('retro') : st.sec==='notas' ? exportarTodo() : exportarLista('resumen')}, {txt:'Toda la base', icono:'download', run:exportarTodo}]}];
      },
      mtime: () => doc.mtime,
      async externo(){ await cargar(); if(st.sec!=='rellenar') render(); },
      sucio: () => !!(LS.drsRellenar && LS.drsRellenar.pendiente()),   // datos de Rellenar DRS sin guardar en el PDF
      activado(){}
    };

  } };
})();
