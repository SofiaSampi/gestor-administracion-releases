/* Módulo FACTURACIÓN (nativo desde 1.0.3; reemplaza a la webapp 01 embebida).
   Datos: datos/facturacion/data.json (mismo formato que la webapp: servicios, meses[AAAA-MM].items, papelera, config)
   Subsectores:
   - Estado general:  tablero por estado, responsable y datos faltantes (clic = Seguimiento filtrado)
   - Seguimiento:     líneas del período + pendientes anteriores; notas en ventana aparte, ordenadas por fecha
   - Cierre:          fecha de cierre por factura y resumen por gerente (mail a Outlook)
   - Servicios:       servicios cargados (alta, edición, baja, reactivación)
   - Papelera:        lo borrado, recuperable */
(function(){
  const {sys, ui, db, auth} = LS;
  const {esc} = ui; const I = LS.icon;
  const ARCH = () => db.p.datos('facturacion', 'data.json');
  const MESES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  const mesLabel = k => { if(!k) return ''; const [y,m] = String(k).split('-'); return m ? MESES[Number(m)-1]+' '+y : k; };
  const addMes = (k, n) => { let [y,m] = k.split('-').map(Number); m += n; while(m>12){m-=12;y++} while(m<1){m+=12;y--} return y+'-'+String(m).padStart(2,'0'); };
  const fmtF = iso => iso ? String(iso).slice(0,10).split('-').reverse().join('/') : '';
  const unaLinea = t => String(t == null ? '' : t).replace(/\s*\n+\s*/g, ' · ').trim();

  /* Estados (orden pedido por Sofía). La clave es la que se guarda en data.json. */
  const ESTADOS = [
    ['',                      'Sin estado',                 'neutro'],
    ['informacion pendiente', 'Información pendiente',      'warn'],
    ['enviado a facturar',    'Enviado a facturar (Chile)', 'info'],
    ['pendiente aprobacion',  'Pendiente aprobación',       'violeta'],
    ['pendiente OC',          'Pendiente O.C.',             'danger'],
    ['oc solicitada',         'Solicitud O.C.',             'teal'],
    ['lista para enviar',     'Listo para enviar',          'brand'],
    ['enviado',               'Enviado',                    'ok']
  ];
  const estLabel = e => (ESTADOS.find(x=>x[0]===(e||''))||[,e||'Sin estado'])[1];
  const estTono = e => (ESTADOS.find(x=>x[0]===(e||''))||[,,'neutro'])[2];
  const EMPRESAS_SIN_SISTEMA = ['LINKSOLUTION LLC', 'GRUPO LS'];
  const empresaSinSistema = s => EMPRESAS_SIN_SISTEMA.includes((s.empresa||'').trim());
  const MOD_INC = ['CCT 100%','CCT 85% IPC 15%','IPC 100%','UF','No aplica'];

  function faltantes(s, it){
    const f = [], sinSist = empresaSinSistema(s);
    if(!s.cuit && !sinSist) f.push('CUIT');
    if(!s.pedido && !s.agrupado && !sinSist) f.push('Pedido');
    if(!s.servicio) f.push('Descripción');
    if(!s.porPortal && !s.contactosPara) f.push('Contactos');
    if(s.requiereOC && (!s.ordenCompra || /^no$/i.test(s.ordenCompra))) f.push('Orden de compra');
    if(it && !it.facturacionMes) f.push('Período');
    return f;
  }
  const factDe = (s, bucket) => s.modalidad==='encurso' ? addMes(bucket, 1) : bucket;
  const servicioActivoEn = (s, bucket) => { const st = s.fechaInicio ? s.fechaInicio.slice(0,7) : null; return !st || factDe(s, bucket) >= st; };
  const servicioVigenteEn = (s, bucket) => { const bm = s.fechaBaja ? s.fechaBaja.slice(0,7) : null; return !bm || factDe(s, bucket) <= bm; };
  const partesResp = r => { const p = String(r||'').split(/\s*-\s*/); return {gerente:(p[0]||'').trim() || '(sin responsable)', supervisor:p.slice(1).join(' - ').trim()}; };

  /* ---------- Notas con fecha escrita en el texto ----------
     Cada renglón que empieza con una fecha (27/08, 16-09, 07-10-2026, 21.09.26) abre una entrada;
     los renglones siguientes sin fecha se suman a esa entrada. Sin año: se toma el del período. */
  const RX_FECHA = /^\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?(?![\d\/\-.])[\s:\-–]*/;
  function notasEntradas(txt, anioDef){
    const out = []; let cur = null;
    String(txt||'').split(/\r?\n/).forEach(l=>{
      const m = l.match(RX_FECHA);
      const d = m ? +m[1] : 0, mo = m ? +m[2] : 0;
      if(m && d>=1 && d<=31 && mo>=1 && mo<=12){
        let y = m[3] ? +m[3] : +anioDef; if(y < 100) y += 2000;
        cur = {fecha: y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'), txt: l.slice(m[0].length).trim()}; out.push(cur);
      } else if(l.trim()){
        if(cur) cur.txt += (cur.txt?'\n':'') + l.trim(); else { cur = {fecha:'', txt:l.trim()}; out.push(cur); }
      }
    });
    return out.sort((a,b)=> (a.fecha||'0').localeCompare(b.fecha||'0'));
  }

  /* ---------- Normalización / migración a 1.0.3 (idempotente) ---------- */
  function normalizar(d){
    let cambio = false;
    d.config = d.config || {}; d.servicios = d.servicios || []; d.meses = d.meses || {}; d.papelera = d.papelera || [];
    d.config.empresas = d.config.empresas || ['LINKSOLUTION SRL','LINKSOLUTION LLC','GRUPO LS','TECTUARY'];
    d.servicios.forEach(s=>{
      ['proceso','contactosPara','contactosCC','fechaBaja','vigenciaFin','modalidadIncremento','esquemaIncremento'].forEach(k=>{ if(s[k]==null) s[k] = ''; });
      if(!s.vigencia) s.vigencia = 'indeterminada';
      if(!s.modalidad) s.modalidad = /mes en curso/i.test((s.servicio||'')+' '+(s.observaciones||'')) ? 'encurso' : 'vencido';
      if(s.requiereOC===undefined){ s.requiereOC = s.grupo==='B'; cambio = true; }   // 1.0.4: reemplaza al grupo B
    });
    const fix = it=>{
      if(!it) return;
      if(it.estado==='verificar informacion'){ it.estado = 'informacion pendiente'; cambio = true; }
      if(it.estado==='cliente nuevo'){ it.estado = ''; it.nuevo = true; cambio = true; }
      if(!it.id){ it.id = ui.uid('l'); cambio = true; }
    };
    Object.values(d.meses).forEach(m=>{ m.items = m.items || []; m.items.forEach(fix); });
    d.papelera.forEach(p=>{ if(p.item) fix(p.item); (p.items||[]).forEach(x=>fix(x.item)); });
    const est = ESTADOS.map(e=>e[0]).filter(Boolean);
    if(JSON.stringify(d.config.estados)!==JSON.stringify(est)){ d.config.estados = est; cambio = true; }
    if(d.plantillas !== undefined){ delete d.plantillas; cambio = true; }
    return cambio;
  }

  /* Los recordatorios que tenía la webapp pasan al Calendario (para todos) */
  async function migrarEventos(d){
    if(d.eventosMigrados || !(d.eventos||[]).length) return 0;
    const F = db.p.datos('calendario','eventos.json');
    await sys.mkdir(db.p.datos('calendario'));
    const doc = new LS.Doc(F, ()=>({version:1, eventos:[]}));
    const nuevos = d.eventos.map(e=>({id:'f-'+e.id, titulo:e.titulo, nota:e.nota||'', hora:e.hora||'', sonido:!!e.sonido, persistente:false, repetir:'no', fecha:e.fecha, creadoPor:'migración Facturación'}));
    await doc.update(c=>{ c.eventos = c.eventos || []; nuevos.forEach(n=>{ if(!c.eventos.some(x=>x.id===n.id)) c.eventos.push(n); }); c.savedAt = ui.ahoraISO(); c.savedBy = auth.user.usuario; });
    LS.log('facturacion', 'Pasó '+nuevos.length+' recordatorio(s) de Facturación al Calendario');
    return nuevos.length;
  }

  /* Fecha de cada cambio de estado (para el aviso de "Listo para enviar" hace más de 2 días) */
  function sellar(d, previo){
    const ant = {}; Object.values((previo&&previo.meses)||{}).forEach(m=> (m.items||[]).forEach(it=>{ if(it.id) ant[it.id] = it; }));
    const ahora = ui.ahoraISO();
    Object.values(d.meses||{}).forEach(m=> (m.items||[]).forEach(it=>{
      const p = ant[it.id];
      if(p && (p.estado||'')===(it.estado||'')) it.estadoDesde = p.estadoDesde || it.estadoDesde || ahora;
      else if(p || !it.estadoDesde) it.estadoDesde = ahora;
    }));
  }

  LS.factUI = {ESTADOS, estLabel, estTono, mesLabel, notasEntradas, normalizar, faltantes, partesResp};

  /* ================= INTERFAZ ================= */
  LS.nativos.facturacion = { montar(root, ctx){
    const doc = new LS.Doc(ARCH());
    let D = null;
    const RO = () => ctx.readonly;
    const st = {
      sec:'estado', mes:null,
      seg:{mostrar:'actual_ant', soloPend:true}, gSeg:{filtros:{}, orden:null},
      serv:{estado:'vigentes'}, gServ:{filtros:{}, orden:{k:'cliente', dir:'asc'}},
      gPap:{filtros:{}, orden:null}, cal:null, cierreMes:'todos'
    };

    const meses = () => Object.keys(D.meses).sort();
    const servDe = id => D.servicios.find(s=>s.id===id);
    const itemsMes = k => (D.meses[k] ? D.meses[k].items : []);
    function buscarItem(d, id){ for(const mes of Object.keys(d.meses)){ const ix = d.meses[mes].items.findIndex(it=>it.id===id); if(ix>=0) return {mes, ix, it:d.meses[mes].items[ix]}; } return null; }

    async function cargar(){
      try{
        if(!(await sys.exists(ARCH()))){ await LS.shell.importarLegado(ctx.tab); }
        if(!(await sys.exists(ARCH()))){
          root.innerHTML = `<div class="scroll"><div class="empty">${I('receipt')}<br>Facturación todavía no tiene datos en el programa.${RO()?' La administradora los importa la primera vez que abre el módulo.':' Importalos desde Administración → Módulos y datos.'}</div></div>`;
          return false;
        }
        await doc.load();
        if(normalizar(doc.data) && !RO()){
          await LS.backups.crear('antes-actualizar-facturacion').catch(()=>{});
          await doc.update(d=>{ normalizar(d); d.updatedAt = ui.ahoraISO().slice(0,19); });
          LS.log('facturacion', 'Actualizó los datos al formato nuevo (estados, identificadores de línea, Requiere OC)');
        }
        if(!RO() && (doc.data.eventos||[]).length && !doc.data.eventosMigrados){
          try{ const n = await migrarEventos(doc.data); await doc.update(d=>{ d.eventosMigrados = true; }); if(n) ui.toast(n+' recordatorio(s) de Facturación pasaron al Calendario.'); }catch(e){ console.warn(e); }
        }
        D = doc.data; normalizar(D);
        if(!st.mes || !D.meses[st.mes]) st.mes = meses().slice(-1)[0] || null;
        return true;
      }catch(e){ root.innerHTML = `<div class="scroll"><div class="banner danger">${I('alert')} No se pudo leer data.json: ${esc(sys.errMsg(e))}</div></div>`; return false; }
    }

    async function guardar(fn, msg){
      if(RO()){ ui.toast('Modo consulta: no se puede guardar.'); return false; }
      try{
        let previo = null, res;
        await doc.update(d=>{ previo = JSON.stringify(d, null, 1); normalizar(d); const ant = JSON.parse(previo); res = fn(d); sellar(d, ant); d.updatedAt = ui.ahoraISO().slice(0,19); });
        D = doc.data;
        if(previo) LS.shell.pushUndo('facturacion', {archivo:'data.json', text:previo, desc: msg || 'Cambio en Facturación'});
        ctx.estado('Guardado '+new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}));
        if(msg) LS.log('facturacion', msg);
        return res === undefined ? true : res;
      }catch(e){ ui.alerta(esc(sys.errMsg(e)), 'No se pudo guardar'); return false; }
    }

    const scroll = (html, keep) => { const sc = {}; root.querySelectorAll('[data-keep]').forEach(el=> sc[el.dataset.keep] = el.scrollTop);
      root.innerHTML = `<div class="scroll" data-keep="${keep||st.sec}">${html}</div>`; root.querySelectorAll('[data-keep]').forEach(el=>{ if(sc[el.dataset.keep]!=null) el.scrollTop = sc[el.dataset.keep]; }); return root.firstElementChild; };

    /* ================= SEGUIMIENTO ================= */
    /* Filas del período + (según "Mostrar") las pendientes de períodos anteriores */
    function filasSeg(mes, mostrar){
      let rows = [];
      if(mostrar!=='solo_ant') itemsMes(mes).forEach(it=> rows.push({id:it.id, it, mes, s:servDe(it.servicioId), back:false}));
      if(mostrar!=='actual') meses().filter(k=>k<mes).forEach(k=> itemsMes(k).forEach(it=>{ if(it.estado!=='enviado') rows.push({id:it.id, it, mes:k, s:servDe(it.servicioId), back:true}); }));
      rows = rows.filter(r=>r.s);
      rows.forEach(r=>{ if(r.back) r._clase = 'fila-back'; });
      return rows.sort((a,b)=> (a.s.cliente||'').localeCompare(b.s.cliente||'', 'es') || a.mes.localeCompare(b.mes));
    }
    function defsSeg(){
      const resps = [...new Set(D.servicios.map(s=>s.responsable).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'es'));
      return [
        {k:'q', l:'Buscar cliente, servicio, pedido, CUIT…', tipo:'texto', val:r=>[r.s.cliente, r.s.servicio, r.s.pedido, r.s.cuit, r.it.notas]},
        {k:'periodo', l:'Período', tipo:'lista', sinTodos:true, fijo:true, noFiltra:true, opciones:meses().slice().reverse().map(k=>({v:k, l:mesLabel(k)}))},
        {k:'mostrar', l:'Mostrar', tipo:'lista', sinTodos:true, fijo:true, noFiltra:true, opciones:[{v:'actual_ant', l:'Período + pendientes anteriores'},{v:'actual', l:'Solo el período'},{v:'solo_ant', l:'Solo pendientes anteriores'}]},
        {k:'estado', l:'Estado', tipo:'lista', opciones:ESTADOS.map(e=>({v:e[0]||'__sin__', l:e[1]})), cumple:(r,v)=> v==='__sin__' ? !r.it.estado : r.it.estado===v},
        {k:'empresa', l:'Empresa', tipo:'lista', opciones:D.config.empresas, val:r=>r.s.empresa},
        {k:'gerente', l:'Gerente', tipo:'lista', opciones:[...new Set(resps.map(r=>partesResp(r).gerente))].sort((a,b)=>a.localeCompare(b,'es')), cumple:(r,v)=> partesResp(r.s.responsable).gerente===v},
        {k:'responsable', l:'Responsable', tipo:'lista', opciones:resps, val:r=>r.s.responsable},
        {k:'soloPend', l:'Solo pendientes', tipo:'check', cumple:(r)=> st.seg.estado ? true : r.it.estado!=='enviado'},
        {k:'faltantes', l:'Con datos faltantes', tipo:'check', cumple:r=> faltantes(r.s, r.it).length>0}
      ];
    }
    function filasVisibles(){
      st.seg.periodo = st.mes; st.seg.mostrar = st.seg.mostrar || 'actual_ant';
      return LS.comp.aplicarFiltros(filasSeg(st.mes, st.seg.mostrar), defsSeg(), st.seg);
    }
    const chipsCliente = (r) => {
      const s = r.s, it = r.it; const c = [];
      if(it.nuevo) c.push('<span class="chip t-brand">cliente nuevo</span>');
      if(it.eventual) c.push('<span class="chip t-violeta">eventual</span>');
      if(s.agrupado) c.push('<span class="chip t-info" title="Varios pedidos en una sola factura">agrupada</span>');
      if(s.fechaBaja && it.facturacionMes && s.fechaBaja.slice(0,7)===it.facturacionMes) c.push(`<span class="chip t-danger">baja ${fmtF(s.fechaBaja)}: proporcional</span>`);
      return c.join(' ');
    };
    function colsSeg(){
      const ro = RO();
      return [
        {k:'cliente', l:'Cliente', w:'170px', val:r=>r.s.cliente, html:r=>`<b>${esc(r.s.cliente)}</b>${chipsCliente(r)?'<div class="chips">'+chipsCliente(r)+'</div>':''}`},
        {k:'servicio', l:'Servicio', w:'200px', val:r=>r.s.servicio, html:r=>`<span class="txt2">${esc(r.s.servicio||'—')}</span>`},
        {k:'empresa', l:'Empresa', w:'105px', val:r=>r.s.empresa},
        {k:'responsable', l:'Responsable', w:'115px', val:r=>r.s.responsable},
        {k:'periodo', l:'Período', w:'100px', val:r=>r.it.facturacionMes ? mesLabel(r.it.facturacionMes) : 'Sin período',
          html:r=>(r.it.facturacionMes ? esc(mesLabel(r.it.facturacionMes)) : '<span class="chip t-danger">sin período</span>') + (r.back?`<div class="chips"><span class="chip t-warn" title="Línea de ${esc(mesLabel(r.mes))} todavía sin enviar">pend. desde ${esc(mesLabel(r.mes))}</span></div>`:'') + (r.s.modalidad==='encurso'?'<div class="muted sm">mes en curso</div>':'')},
        {k:'estado', l:'Estado', w:'165px', val:r=>estLabel(r.it.estado),
          html:r=>(ro ? LS.comp.estado(estLabel(r.it.estado), estTono(r.it.estado)) :
            `<select class="inp sel-est t-${estTono(r.it.estado)}" data-est="${esc(r.id)}">${ESTADOS.map(e=>`<option value="${esc(e[0])}" ${(r.it.estado||'')===e[0]?'selected':''}>${esc(e[1])}</option>`).join('')}</select>`) +
            (r.it.estado==='enviado' ? `<div class="sm ${r.it.fechaEnvio?'muted':'txt-warn'} ${ro?'':'link'}" ${ro?'':`data-fenv="${esc(r.id)}" title="Corregir la fecha de envío"`}>${r.it.fechaEnvio ? 'Enviada el '+fmtF(r.it.fechaEnvio) : 'Sin fecha de envío'}${ro?'':' ✎'}</div>` : '')},
        {k:'notas', l:'Notas', w:'78px', val:r=>{ const n = notasEntradas(r.it.notas, (r.it.facturacionMes||r.mes).slice(0,4)); return n.length ? n.length+' nota'+(n.length===1?'':'s') : ''; },
          html:r=>{ const n = notasEntradas(r.it.notas, (r.it.facturacionMes||r.mes).slice(0,4)); const u = n[n.length-1];
            return `<button class="btn sm nota-btn ${n.length?'on':''}" data-notas="${esc(r.id)}" title="${n.length?esc(unaLinea((u.fecha?fmtF(u.fecha)+' ':'')+u.txt).slice(0,160)):'Agregar nota'}">${I('pencilbox')} ${n.length ? n.length+(u.fecha?' · '+fmtF(u.fecha).slice(0,5):'') : ''}</button>`; }},
        {k:'faltan', l:'Faltan', w:'110px', val:r=>faltantes(r.s, r.it).join(', ') || 'Completo',
          html:r=>{ const f = faltantes(r.s, r.it); return f.length ? f.map(x=>`<span class="chip t-danger">${esc(x)}</span>`).join(' ') : `<span class="txt-ok">${I('check')}</span>`; }},
        {k:'acc', l:'', w: ro?'60px':'112px', nofiltro:true, clase:'col-acc', html:r=> ro ? `<button class="btn sm" data-ver="${esc(r.id)}">Ver</button>` :
          `<div class="acc nw">${r.it.estado!=='enviado'?`<button class="btn sm ic t-ok" data-env="${esc(r.id)}" title="Marcar como enviada">${I('check')}</button>`:''}<button class="btn sm ic" data-edit="${esc(r.id)}" title="Editar servicio y línea">${I('edit')}</button><button class="btn sm ic" data-del="${esc(r.id)}" title="Borrar la línea (va a la Papelera)">${I('trash')}</button></div>`}
      ];
    }
    function vSeguimiento(){
      if(!st.mes) return vVacio();
      const n = filasSeg(st.mes, 'actual_ant').filter(r=>r.back).length;
      const el = scroll(LS.comp.encabezado('Seguimiento de facturación', `Período <b>${esc(mesLabel(st.mes))}</b>${n && st.seg.mostrar!=='actual'?` · <span class="txt-warn">${n} pendiente(s) de períodos anteriores (filas resaltadas)</span>`:''}`,
        `${st.revisar?`<button class="btn" data-a="revisar" title="Facturas del último Excel importado que no se pudieron enlazar">${I('alert')} Facturas para revisar</button>`:''}${RO()?'':`<button class="btn" data-a="aprob" title="Excel de facturas emitidas (APROBACION DE FC): las líneas pendientes pasan a Listo para enviar">${I('upload')} Importar facturas emitidas</button><button class="btn" data-a="linea">${I('plus')} Agregar línea</button>`}<button class="btn" data-a="xls">${I('excel')} Exportar a Excel</button>`) +
        `<div id="flt"></div><div id="tabla"></div>`, 'seg');
      el.querySelector('[data-a="xls"]').onclick = exportarSeguimiento;
      const bl = el.querySelector('[data-a="linea"]'); if(bl) bl.onclick = agregarLinea;
      const ba = el.querySelector('[data-a="aprob"]'); if(ba) ba.onclick = importarAprobadas;
      const br = el.querySelector('[data-a="revisar"]'); if(br) br.onclick = facturasParaRevisar;
      pintarFiltrosSeg(); pintarTablaSeg();
    }
    function pintarFiltrosSeg(){
      const c = root.querySelector('#flt'); if(!c) return;
      st.seg.periodo = st.mes;
      LS.comp.barraFiltros(c, {defs:defsSeg(), estado:st.seg, onCambio:(txt)=>{
        if(st.seg.periodo && st.seg.periodo!==st.mes){ st.mes = st.seg.periodo; return vSeguimiento(); }
        if(!st.seg.mostrar) st.seg.mostrar = 'actual_ant';
        pintarTablaSeg(); if(!txt) pintarFiltrosSeg();
      }});
    }
    function pintarTablaSeg(){
      const c = root.querySelector('#tabla'); if(!c) return;
      const filas = filasVisibles(); const cols = colsSeg();
      const g = LS.grid.render({id:'fact.seg', cols, filas, estado:st.gSeg, vacio:'Sin líneas con estos filtros.', ordenClick:true});
      c.innerHTML = `<div class="grid-cuenta muted">${g.vis.length} línea${g.vis.length===1?'':'s'}</div>` + g.html;
      LS.grid.cablear(c, {id:'fact.seg', cols, filas, estado:st.gSeg, repintar:pintarTablaSeg, ordenClick:true});
      cablearAcciones(c);
    }
    function cablearAcciones(c){
      c.querySelectorAll('[data-est]').forEach(s=> s.onchange = ()=> cambiarEstado(s.dataset.est, s.value));
      c.querySelectorAll('[data-fenv]').forEach(b=> b.onclick = ()=> pedirFechaEnvio(b.dataset.fenv));
      c.querySelectorAll('[data-env]').forEach(b=> b.onclick = ()=> pedirFechaEnvio(b.dataset.env));
      c.querySelectorAll('[data-notas]').forEach(b=> b.onclick = ()=> ventanaNotas(b.dataset.notas));
      c.querySelectorAll('[data-edit]').forEach(b=> b.onclick = ()=>{ const x = buscarItem(D, b.dataset.edit); if(x) formServicio(servDe(x.it.servicioId), x); });
      c.querySelectorAll('[data-ver]').forEach(b=> b.onclick = ()=>{ const x = buscarItem(D, b.dataset.ver); if(x) formServicio(servDe(x.it.servicioId), x); });
      c.querySelectorAll('[data-del]').forEach(b=> b.onclick = ()=> borrarLinea(b.dataset.del));
    }
    const repintar = () => render();

    async function cambiarEstado(id, val){
      if(val==='enviado') return pedirFechaEnvio(id);
      const x = buscarItem(D, id); if(!x) return;
      const s = servDe(x.it.servicioId) || {};
      await guardar(d=>{ const y = buscarItem(d, id); if(y){ y.it.estado = val; y.it.fechaEnvio = ''; if(val) delete y.it.nuevo; } }, `${s.cliente||''} · ${mesLabel(x.it.facturacionMes||x.mes)}: ${estLabel(val)}`);
      repintar();
    }
    async function pedirFechaEnvio(id){
      const x = buscarItem(D, id); if(!x) return;
      const s = servDe(x.it.servicioId) || {}; const hoy = ui.hoy(); const ya = x.it.estado==='enviado';
      const dia = n => { const d = new Date(); d.setDate(d.getDate()-n); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
      const v = await ui.modal({titulo: ya ? 'Fecha de envío' : 'Confirmar envío', html:`<p class="muted" style="margin-top:0">${esc(s.cliente||'')}${s.servicio?' · '+esc(s.servicio):''}<br>Período: ${esc(mesLabel(x.it.facturacionMes||x.mes))}</p>
        <div class="field"><label>¿Qué día se envió la factura?</label><input class="inp" type="date" id="fE" value="${esc(x.it.fechaEnvio||hoy)}" max="${hoy}"></div>
        <div class="row"><button class="btn sm" data-d="0">Hoy</button><button class="btn sm" data-d="1">Ayer</button><button class="btn sm" data-d="2">Anteayer</button></div>
        <div class="txt-warn sm" id="fA" style="margin-top:8px"></div>`,
        botones:[{txt:'Cancelar', val:null},{txt: ya?'Guardar fecha':'Marcar como enviada', primary:true, val:ov=>ov.querySelector('#fE').value, validar:ov=>{ const f = ov.querySelector('#fE').value; if(!/^\d{4}-\d{2}-\d{2}$/.test(f)){ ui.toast('Elegí una fecha válida.'); return false; } if(f>hoy){ ui.toast('La fecha no puede ser posterior a hoy.'); return false; } return true; }}],
        onOpen: ov=>{ const f = ov.querySelector('#fE'), a = ov.querySelector('#fA'); const aviso = ()=>{ a.textContent = f.value && f.value!==hoy ? 'Vas a registrar el envío con fecha '+fmtF(f.value)+' (distinta a hoy).' : ''; };
          f.oninput = aviso; aviso(); ov.querySelectorAll('[data-d]').forEach(b=> b.onclick = ()=>{ f.value = dia(+b.dataset.d); aviso(); }); }});
      if(!v){ repintar(); return; }
      await guardar(d=>{ const y = buscarItem(d, id); if(y){ y.it.estado = 'enviado'; y.it.fechaEnvio = v; delete y.it.nuevo; } }, `${s.cliente||''} · ${mesLabel(x.it.facturacionMes||x.mes)}: enviada el ${fmtF(v)}`);
      ui.toast((ya?'Fecha de envío actualizada':'Marcada como enviada')+': '+(s.cliente||'')+' · '+fmtF(v));
      repintar();
    }

    /* ---------- Notas (ventana aparte, ordenadas por fecha) ---------- */
    async function ventanaNotas(id){
      const x = buscarItem(D, id); if(!x) return;
      const s = servDe(x.it.servicioId) || {}; const anio = (x.it.facturacionMes||x.mes).slice(0,4);
      const otras = []; meses().forEach(k=> itemsMes(k).forEach(it=>{ if(it.servicioId===x.it.servicioId && it.id!==id && (it.notas||'').trim()) otras.push({mes:k, it}); }));
      const lista = txt => { const n = notasEntradas(txt, anio); return n.length ? `<div class="notas">${n.map(e=>`<div class="nota"><div class="nota-f">${e.fecha?fmtF(e.fecha):'<span class="muted">Sin fecha</span>'}</div><div class="nota-t">${esc(e.txt).replace(/\n/g,'<br>')}</div></div>`).join('')}</div>` : '<div class="empty" style="padding:14px">Todavía no hay notas en este período.</div>'; };
      const ro = RO();
      await LS.comp.ventana({titulo:'Notas · '+(s.cliente||''), html:`<p class="muted" style="margin-top:0">${esc(s.servicio||'')}<br>Período <b>${esc(mesLabel(x.it.facturacionMes||x.mes))}</b> · las notas valen solo para este período (no se copian al abrir el siguiente).</p>
        <div id="nLista">${lista(x.it.notas)}</div>
        ${ro?'':`<div class="box" style="margin-top:12px"><h3>${I('plus')} Nueva nota</h3>
          <div class="row" style="align-items:flex-start"><input class="inp" type="date" id="nF" value="${ui.hoy()}" style="width:150px"><textarea class="inp" id="nT" rows="2" style="flex:1" placeholder="Ej: reclamé la OC al cliente"></textarea><button class="btn primary" id="nAdd">Agregar</button></div></div>
          <details style="margin-top:10px"><summary class="link">Editar el texto completo</summary><textarea class="inp mono" id="nTodo" rows="8" style="width:100%;margin-top:6px">${esc(x.it.notas||'')}</textarea>
          <div class="muted sm">Cada renglón que empieza con una fecha (ej. 16-09 o 07/10/2026) es una nota. Para borrar una nota, borrá su renglón.</div><button class="btn sm" id="nGua" style="margin-top:6px">${I('save')} Guardar texto</button></details>`}
        ${otras.length?`<details style="margin-top:12px"><summary class="link">Notas de otros períodos de este servicio (${otras.length})</summary>${otras.map(o=>`<h4 style="margin:10px 0 4px">${esc(mesLabel(o.it.facturacionMes||o.mes))}</h4>${lista(o.it.notas)}`).join('')}</details>`:''}`,
        botones:[{txt:'Cerrar', val:null, primary:true}],
        onOpen: ov=>{
          if(ro) return;
          const pintar = ()=>{ const y = buscarItem(D, id); ov.querySelector('#nLista').innerHTML = lista(y && y.it.notas); const t = ov.querySelector('#nTodo'); if(t && y) t.value = y.it.notas||''; };
          ov.querySelector('#nAdd').onclick = async ()=>{
            const t = ov.querySelector('#nT').value.trim(), f = ov.querySelector('#nF').value; if(!t){ ui.toast('Escribí la nota.'); return; }
            const linea = (f ? f.split('-').reverse().join('-')+' ' : '') + t.replace(/\r?\n/g,' ');
            if(await guardar(d=>{ const y = buscarItem(d, id); if(y) y.it.notas = ((y.it.notas||'').trim() ? y.it.notas.trim()+'\n' : '') + linea; }, `Nota en ${s.cliente||''} · ${mesLabel(x.it.facturacionMes||x.mes)}`)){ ov.querySelector('#nT').value = ''; ov.querySelector('#nF').value = ui.hoy(); pintar(); }
          };
          ov.querySelector('#nGua').onclick = async ()=>{ const t = ov.querySelector('#nTodo').value.replace(/\s+$/,'');
            if(await guardar(d=>{ const y = buscarItem(d, id); if(y) y.it.notas = t; }, `Editó las notas de ${s.cliente||''} · ${mesLabel(x.it.facturacionMes||x.mes)}`)){ pintar(); ui.toast('Notas guardadas'); } };
        }});
      repintar();
    }

    /* ---------- Agregar línea / borrar / limpiar ---------- */
    async function agregarLinea(){
      if(RO()) return;
      const servs = D.servicios.filter(s=>s.activo!==false).sort((a,b)=>(a.cliente||'').localeCompare(b.cliente||'','es'));
      const v = await ui.modal({titulo:'Agregar línea · '+mesLabel(st.mes), avisarCambios:true, html:`
        <div class="field"><label>Cliente / servicio</label><select class="inp" id="aS"><option value="">— Elegí un servicio cargado —</option>${servs.map(s=>`<option value="${s.id}">${esc(s.cliente)} · ${esc((s.servicio||'').slice(0,70))}</option>`).join('')}</select></div>
        <div class="grid2"><div class="field"><label>Período a facturar</label><input class="inp" type="month" id="aP" value="${esc(st.mes)}"></div>
          <div class="field"><label>Estado</label><select class="inp" id="aE">${ESTADOS.filter(e=>e[0]!=='enviado').map(e=>`<option value="${esc(e[0])}">${esc(e[1])}</option>`).join('')}</select></div></div>
        <div class="field"><label>Nota (opcional)</label><input class="inp" id="aN" placeholder="Ej: período abril pendiente"></div>
        <label class="chk"><input type="checkbox" id="aV" checked> Eventual: no se copia al abrir períodos nuevos</label>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Agregar línea', primary:true, validar:ov=>{ if(!ov.querySelector('#aS').value){ ui.toast('Elegí un servicio.'); return false; } return true; },
          val:ov=>({sid:Number(ov.querySelector('#aS').value), per:ov.querySelector('#aP').value, est:ov.querySelector('#aE').value, nota:ov.querySelector('#aN').value.trim(), ev:ov.querySelector('#aV').checked})}]});
      if(!v) return;
      const s = servDe(v.sid);
      await guardar(d=>{ d.meses[st.mes] = d.meses[st.mes] || {items:[]}; d.meses[st.mes].items.push({id:ui.uid('l'), servicioId:v.sid, estado:v.est, facturacionMes:v.per, fechaEnvio:'', notas: v.nota ? fmtF(ui.hoy()).replace(/\//g,'-')+' '+v.nota : '', eventual:v.ev}); }, `Agregó una línea: ${s?s.cliente:''} · ${mesLabel(v.per)}`);
      ui.toast('Línea agregada'); if(st.sec!=='seguimiento'){ st.sec = 'seguimiento'; ctx.setSeccion('seguimiento'); } render();
    }
    function papelera(d, entries){ d.papelera = d.papelera || []; entries.forEach(e=>{ e.id = e.id || ui.uid('p'); e.ts = e.ts || Date.now(); e.por = auth.user.usuario; d.papelera.push(e); }); if(d.papelera.length>300) d.papelera = d.papelera.slice(-300); }
    function restaurar(d, e){
      if(e.tipo==='linea'){ d.meses[e.mes] = d.meses[e.mes] || {items:[]}; d.meses[e.mes].items.push(e.item); }
      else if(e.tipo==='servicio'){ if(!d.servicios.some(s=>s.id===e.servicio.id)) d.servicios.push(e.servicio); (e.items||[]).forEach(li=>{ d.meses[li.mes] = d.meses[li.mes] || {items:[]}; d.meses[li.mes].items.push(li.item); }); }
      d.papelera = d.papelera.filter(x=>x.id!==e.id);
    }
    async function borrarLinea(id){
      const x = buscarItem(D, id); if(!x) return;
      const s = servDe(x.it.servicioId); const nom = s ? (s.cliente||'(sin cliente)')+(s.servicio?' · '+s.servicio:'') : '(línea sin servicio)';
      if(!(await ui.confirmar(`¿Borrar esta línea de <b>${esc(mesLabel(x.mes))}</b>?<br>${esc(nom)}<br><span class="muted">Va a la Papelera: la podés restaurar.</span>`, {si:'Borrar', peligro:true}))) return;
      const pid = ui.uid('p');
      await guardar(d=>{ const y = buscarItem(d, id); if(!y) return; const [it] = d.meses[y.mes].items.splice(y.ix, 1); papelera(d, [{id:pid, tipo:'linea', mes:y.mes, item:it, label:nom+' · '+mesLabel(y.mes)}]); }, 'Borró la línea '+nom+' · '+mesLabel(x.mes));
      repintar();
      ui.toast('Línea movida a la Papelera', {action:'Deshacer', run:async ()=>{ await guardar(d=>{ const e = d.papelera.find(p=>p.id===pid); if(e) restaurar(d, e); }, 'Restauró '+nom); repintar(); }});
    }
    async function limpiarEnBlanco(){
      const blanco = it => { const s = servDe(it.servicioId); return !s || !((s.cliente||'').trim()); };
      let n = 0; meses().forEach(k=> itemsMes(k).forEach(it=>{ if(blanco(it)) n++; }));
      const sv = D.servicios.filter(s=>!((s.cliente||'').trim())).length;
      if(!n && !sv) return ui.toast('No hay líneas ni servicios en blanco.');
      if(!(await ui.confirmar(`Encontré <b>${n}</b> línea(s) sin cliente${sv?` y <b>${sv}</b> servicio(s) sin cliente`:''}.<br>¿Moverlos a la Papelera? (se pueden restaurar)`, {si:'Mover a la Papelera'}))) return;
      await guardar(d=>{
        const sd = id => d.servicios.find(s=>s.id===id); const bl = it => { const s = sd(it.servicioId); return !s || !((s.cliente||'').trim()); };
        const e = []; Object.keys(d.meses).forEach(k=>{ d.meses[k].items.filter(bl).forEach(it=> e.push({tipo:'linea', mes:k, item:it, label:'(línea en blanco) · '+mesLabel(k)})); d.meses[k].items = d.meses[k].items.filter(it=>!bl(it)); });
        d.servicios.filter(s=>!((s.cliente||'').trim())).forEach(s=> e.push({tipo:'servicio', servicio:s, items:[], label:'Servicio vacío (id '+s.id+')'}));
        d.servicios = d.servicios.filter(s=>(s.cliente||'').trim());
        papelera(d, e);
      }, 'Limpió líneas en blanco');
      repintar();
    }

    /* ================= FORMULARIO DE SERVICIO (alta / edición, con la línea del período si viene del Seguimiento) ================= */
    async function formServicio(s, linea){
      // 1.0.10: los servicios nuevos se dan de alta en Servicios (base única de clientes); se sincronizan solos con Facturación
      if(!s && ctx.nuevoServicio) return ctx.nuevoServicio();
      const nuevo = !s; s = s || {empresa:D.config.empresas[0], modalidad:'vencido', vigencia:'indeterminada', recurrente:true, activo:true};
      const ro = RO();
      // Si el servicio está vinculado a la base de Clientes, sus datos se editan allá: acá solo los de la línea del período
      let vinc = null; if(!nuevo){ try{ const C = await LS.clientes.datos(); C.clientes.some(c=> c.servicios.some(x=>{ if(x.origen && x.origen.f01===s.id){ vinc = {c, s:x}; return true; } return false; })); }catch(e){} }
      const dis = ro ? 'disabled' : '';
      const disS = ro || vinc ? 'disabled' : '';
      let clientes = []; try{ clientes = (await LS.clientes.lista()).filter(c=>c.activo!==false).map(c=>c.nombre); }catch(e){}
      const dl = [...new Set(D.servicios.map(x=>x.cliente).filter(Boolean).concat(clientes))].sort((a,b)=>a.localeCompare(b,'es'));
      const resps = [...new Set([...(D.config.responsables||[]), ...D.servicios.map(x=>x.responsable)])].filter(Boolean).sort((a,b)=>a.localeCompare(b,'es'));
      const it = linea && linea.it;
      const opt = (arr, v) => arr.map(o=>{ const [k,l] = Array.isArray(o)?o:[o,o]; return `<option value="${esc(k)}" ${String(v||'')===String(k)?'selected':''}>${esc(l)}</option>`; }).join('');
      const html = `<datalist id="dlCli">${dl.map(c=>`<option value="${esc(c)}">`).join('')}</datalist><datalist id="dlResp">${resps.map(c=>`<option value="${esc(c)}">`).join('')}</datalist>
        ${it?`<div class="box" style="margin-bottom:12px;border-left:4px solid var(--brand)"><h3>${I('receipt')} Línea de ${esc(mesLabel(linea.mes))}</h3><div class="grid3">
          <div class="field"><label>Período a facturar</label><input class="inp" type="month" id="fPer" value="${esc(it.facturacionMes||'')}" ${dis}></div>
          <div class="field"><label>Estado</label><select class="inp" id="fEst" ${dis}>${opt(ESTADOS.map(e=>[e[0],e[1]]), it.estado)}</select></div>
          <div class="field"><label>Fecha de envío</label><input class="inp" type="date" id="fEnv" value="${esc(it.fechaEnvio||'')}" max="${ui.hoy()}" ${dis}></div></div>
          <div class="muted sm">Las notas de la línea se ven y se cargan con el botón de notas de la tabla.</div></div>`:''}
        ${vinc?`<div class="banner info" style="border-radius:8px;margin-bottom:10px">${I('building')}<span class="grow">Los datos del servicio se editan en <b>Servicios</b> (base de clientes: ${esc(vinc.c.nombreFantasia)} · ${esc(vinc.s.detalleServicio)}) y se actualizan solos acá. En esta ventana solo se cambian los datos de la línea del período.</span><button class="btn sm" id="fIrServ">${I('external')} Abrir en Servicios</button></div>`:''}
        <div class="grid2">
          <div class="field"><label>Cliente *</label><input class="inp" id="fCli" list="dlCli" value="${esc(s.cliente||'')}" ${disS}></div>
          <div class="field"><label>Empresa de facturación</label><select class="inp" id="fEmp" ${disS}>${opt(D.config.empresas, s.empresa)}</select></div>
        </div>
        <div class="field"><label>Servicio (descripción)</label><input class="inp" id="fSer" value="${esc(s.servicio||'')}" ${disS}></div>
        <div class="grid3">
          <div class="field"><label>Responsable</label><input class="inp" id="fRes" list="dlResp" value="${esc(s.responsable||'')}" placeholder="Gerente - Supervisor" ${disS}></div>
          <div class="field"><label>Modalidad</label><select class="inp" id="fMod" ${disS}>${opt([['vencido','Mes vencido'],['encurso','Mes en curso']], s.modalidad)}</select></div>
          <div class="field"><label>Modalidad de incremento</label><select class="inp" id="fInc" ${disS}><option value="">— Sin definir —</option>${opt(MOD_INC.concat(s.modalidadIncremento && !MOD_INC.includes(s.modalidadIncremento) ? [s.modalidadIncremento] : []), s.modalidadIncremento)}</select></div>
          <div class="field" id="wEsq"><label>Esquema del IPC</label><select class="inp" id="fEsq" ${disS}>${opt([['','—'],'Trimestral','Bimestral','Otro'], s.esquemaIncremento)}</select></div>
          <div class="field"><label>CUIT</label><input class="inp" id="fCuit" value="${esc(s.cuit||'')}" placeholder="30-XXXXXXXX-X" ${disS}></div>
          <div class="field"><label>Pedido (OneSoft)</label><input class="inp" id="fPed" value="${esc(s.pedido||'')}" placeholder="0003 00000000" ${disS}></div>
          <div class="field"><label>Orden de compra</label><input class="inp" id="fOC" value="${esc(s.ordenCompra||'')}" placeholder="Si / No / Nº de OC anual" ${disS}></div>
          <div class="field"><label>Fecha de inicio</label><input class="inp" type="date" id="fIni" value="${esc(s.fechaInicio||'')}" ${disS}></div>
          <div class="field"><label>Fecha de baja</label><input class="inp" type="date" id="fBaj" value="${esc(s.fechaBaja||'')}" ${disS}></div>
          <div class="field"><label>Vigencia del contrato</label><select class="inp" id="fVig" ${disS}>${opt([['indeterminada','Indeterminada'],['fija','Fija (con fecha)']], s.vigencia)}</select></div>
          <div class="field" id="wVig"><label>Contrato vigente hasta</label><input class="inp" type="date" id="fVigF" value="${esc(s.vigenciaFin||'')}" ${disS}></div>
        </div>
        <div class="muted sm" style="margin:-4px 0 8px">LINKSOLUTION LLC y GRUPO LS no se facturan desde el sistema: no se les pide pedido ni CUIT. Con fecha de baja, en ese período la línea queda "proporcional" y después el servicio se da de baja solo.</div>
        <label class="chk"><input type="checkbox" id="fAgr" ${s.agrupado?'checked':''} ${disS}> Facturación agrupada (varios pedidos en una sola factura, ej. Ford)</label>
        <label class="chk"><input type="checkbox" id="fPor" ${s.porPortal?'checked':''} ${disS}> Se factura por portal de proveedores (sin envío por mail)</label>
        <label class="chk"><input type="checkbox" id="fRec" ${s.recurrente!==false?'checked':''} ${disS}> Servicio recurrente (se factura todos los meses: se copia al abrir cada período)</label>
        <label class="chk"><input type="checkbox" id="fROC" ${s.requiereOC?'checked':''} ${disS}> Requiere OC (si falta la orden de compra, figura como dato faltante)</label>
        <div class="grid2" id="wMail" style="margin-top:8px"><div class="field"><label>Contactos (Para, separados con ;)</label><input class="inp" id="fPara" value="${esc(s.contactosPara||'')}" ${disS}></div>
          <div class="field"><label>Con copia (CC)</label><input class="inp" id="fCC" value="${esc(s.contactosCC||'')}" ${disS}></div></div>
        <div class="grid2"><div class="field"><label>Observaciones (permanentes del cliente)</label><textarea class="inp" id="fObs" rows="3" ${disS}>${esc(s.observaciones||'')}</textarea></div>
          <div class="field"><label>Proceso de facturación</label><textarea class="inp" id="fPro" rows="3" ${disS}>${esc(s.proceso||'')}</textarea></div></div>`;
      const v = await ui.modal({titulo: nuevo ? 'Nuevo servicio' : (ro?'':'Editar · ')+(s.cliente||''), lg:true, html, avisarCambios:true,
        botones: ro ? [{txt:'Cerrar', val:null, primary:true}] : [{txt:'Cancelar', val:null},{txt: nuevo ? 'Guardar servicio' : 'Guardar cambios', primary:true,
          validar: ov=>{ if(!ov.querySelector('#fCli').value.trim()){ ui.toast('Falta el nombre del cliente.'); return false; } const fe = ov.querySelector('#fEnv'); if(fe && fe.value > ui.hoy()){ ui.toast('La fecha de envío no puede ser posterior a hoy.'); return false; } return true; },
          val: ov=>{ const q = id => ov.querySelector(id); const inc = q('#fInc').value;
            return {s:{cliente:q('#fCli').value.trim(), empresa:q('#fEmp').value, servicio:q('#fSer').value.trim(), responsable:q('#fRes').value.trim(), requiereOC:q('#fROC').checked,
              modalidad:q('#fMod').value, modalidadIncremento:inc, esquemaIncremento: inc==='CCT 85% IPC 15%' ? q('#fEsq').value : '', cuit:q('#fCuit').value.trim(), pedido:q('#fPed').value.trim(), ordenCompra:q('#fOC').value.trim(),
              fechaInicio:q('#fIni').value, fechaBaja:q('#fBaj').value, vigencia:q('#fVig').value, vigenciaFin: q('#fVig').value==='fija' ? q('#fVigF').value : '',
              agrupado:q('#fAgr').checked, porPortal:q('#fPor').checked, recurrente:q('#fRec').checked, contactosPara:q('#fPara').value.trim(), contactosCC:q('#fCC').value.trim(), observaciones:q('#fObs').value.trim(), proceso:q('#fPro').value.trim()},
              l: q('#fEst') ? {facturacionMes:q('#fPer').value, estado:q('#fEst').value, fechaEnvio:q('#fEnv').value} : null}; }}],
        onOpen: ov=>{ const q = id => ov.querySelector(id);
          const bis = q('#fIrServ'); if(bis) bis.onclick = ()=>{ ov.querySelector('.modal-x') ? ov.querySelector('.modal-x').click() : ov.remove(); setTimeout(()=> ctx.irA && ctx.irA('clientes', {clienteId:vinc.c.id, servicioId:vinc.s.id}), 50); };
          const upd = ()=>{ q('#wEsq').style.display = q('#fInc').value==='CCT 85% IPC 15%' ? '' : 'none'; q('#wVig').style.display = q('#fVig').value==='fija' ? '' : 'none'; q('#wMail').style.display = q('#fPor').checked ? 'none' : ''; };
          ['#fInc','#fVig','#fPor'].forEach(k=> q(k).addEventListener('change', upd)); upd(); }});
      if(!v) return;
      if(nuevo){
        let msg = '';
        await guardar(d=>{
          const id = Math.max(0, ...d.servicios.map(x=>Number(x.id)||0)) + 1;
          const ns = Object.assign({id, activo:true}, v.s); d.servicios.push(ns);
          const mes = meses().slice(-1)[0] || st.mes;
          if(mes && servicioActivoEn(ns, mes)){ d.meses[mes].items.push({id:ui.uid('l'), servicioId:id, estado:'', nuevo:true, facturacionMes:factDe(ns, mes), fechaEnvio:'', notas:''}); msg = 'Se agregó también al seguimiento de '+mesLabel(mes)+'.'; }
          else if(ns.fechaInicio) msg = 'Arranca en '+mesLabel(ns.fechaInicio.slice(0,7))+': entra al seguimiento cuando abras ese período.';
        }, 'Alta de servicio: '+v.s.cliente);
        const f = faltantes(v.s); ui.toast('Servicio agregado. '+msg+(f.length?' Falta: '+f.join(', ')+'.':''), {ms:6000});
      } else {
        await guardar(d=>{ const x = d.servicios.find(y=>y.id===s.id); if(x && !vinc) Object.assign(x, v.s);
          if(v.l && linea){ const y = buscarItem(d, linea.it.id); if(y){ y.it.facturacionMes = v.l.facturacionMes; if(v.l.estado!==y.it.estado && v.l.estado) delete y.it.nuevo; y.it.estado = v.l.estado; y.it.fechaEnvio = v.l.estado==='enviado' ? (v.l.fechaEnvio || y.it.fechaEnvio || ui.hoy()) : ''; } } }, 'Editó el servicio '+v.s.cliente);
      }
      repintar();
    }

    /* ================= SERVICIOS CARGADOS ================= */
    function defsServ(){
      return [
        {k:'q', l:'Buscar cliente, servicio, CUIT, pedido, responsable…', tipo:'texto', val:s=>[s.cliente, s.servicio, s.empresa, s.cuit, s.pedido, s.responsable]},
        {k:'estado', l:'Estado', tipo:'lista', sinTodos:true, fijo:true, opciones:[{v:'vigentes', l:'Vigentes'},{v:'baja', l:'Dados de baja'},{v:'todos', l:'Todos'}], cumple:(s,v)=> v==='todos' ? true : v==='baja' ? s.activo===false : s.activo!==false},
        {k:'empresa', l:'Empresa', tipo:'lista', opciones:D.config.empresas, val:s=>s.empresa},
        {k:'faltantes', l:'Con datos faltantes', tipo:'check', cumple:s=> s.activo!==false && faltantes(s).length>0}
      ];
    }
    function chipsServ(s){
      const c = [], baja = s.activo===false;
      if(baja) c.push('<span class="chip t-neutro">baja</span>');
      if(!baja && s.fechaInicio && st.mes && !servicioActivoEn(s, st.mes)) c.push(`<span class="chip t-brand">inicia ${esc(mesLabel(s.fechaInicio.slice(0,7)))}</span>`);
      if(!baja && s.fechaBaja) c.push(`<span class="chip t-danger">baja programada ${fmtF(s.fechaBaja)}</span>`);
      if(s.vigencia==='fija' && s.vigenciaFin) c.push(s.vigenciaFin < ui.hoy() ? `<span class="chip t-danger">contrato vencido ${fmtF(s.vigenciaFin)}</span>` : `<span class="chip t-neutro">contrato hasta ${fmtF(s.vigenciaFin)}</span>`);
      if(s.agrupado) c.push('<span class="chip t-info">agrupada</span>');
      if(empresaSinSistema(s)) c.push('<span class="chip t-neutro" title="No se factura desde el sistema de gestión">fuera del sistema</span>');
      return c.join(' ');
    }
    function colsServ(){
      const ro = RO();
      return [
        {k:'cliente', l:'Cliente', w:'200px', val:s=>s.cliente, html:s=>`<b>${esc(s.cliente)}</b>${chipsServ(s)?'<div class="chips">'+chipsServ(s)+'</div>':''}`},
        {k:'servicio', l:'Servicio', w:'280px', val:s=>s.servicio},
        {k:'empresa', l:'Empresa', w:'130px', val:s=>s.empresa},
        {k:'responsable', l:'Responsable', w:'150px', val:s=>s.responsable},
        {k:'roc', l:'Requiere OC', w:'100px', val:s=>s.requiereOC?'Sí':'No', html:s=>s.requiereOC?`<span class="chip t-warn">OC</span>${s.ordenCompra?' <span class="muted sm">'+esc(s.ordenCompra)+'</span>':''}`:''},
        {k:'modalidad', l:'Modalidad', w:'110px', val:s=>s.modalidad==='encurso'?'Mes en curso':'Mes vencido'},
        {k:'faltan', l:'Faltan', w:'150px', val:s=>s.activo===false ? '' : (faltantes(s).join(', ')||'Completo'), html:s=> s.activo===false ? '—' : (faltantes(s).map(x=>`<span class="chip t-danger">${esc(x)}</span>`).join(' ') || `<span class="txt-ok">${I('check')}</span>`)},
        {k:'acc', l:'', w: ro?'70px':'230px', nofiltro:true, clase:'col-acc', html:s=> ro ? `<button class="btn sm" data-sv="${s.id}">Ver</button>` : `<div class="acc"><button class="btn sm" data-sv="${s.id}">Editar</button>${s.activo===false?`<button class="btn sm" data-react="${s.id}">Reactivar</button>`:`<button class="btn sm" data-baja="${s.id}">Dar de baja</button>`}<button class="btn sm" data-sdel="${s.id}" title="Eliminar (va a la Papelera)">${I('trash')}</button></div>`}
      ];
    }
    function vServicios(){
      const vig = D.servicios.filter(s=>s.activo!==false).length;
      const el = scroll(LS.comp.encabezado('Servicios cargados', `${vig} vigentes · ${D.servicios.length-vig} dados de baja`,
        `${RO()?'':`<button class="btn primary" data-a="nuevo">${I('plus')} Nuevo servicio</button>`}<button class="btn" data-a="xls">${I('excel')} Exportar a Excel</button>`) + `<div id="flt"></div><div id="tabla"></div>`, 'serv');
      const bn = el.querySelector('[data-a="nuevo"]'); if(bn) bn.onclick = ()=>formServicio(null);
      el.querySelector('[data-a="xls"]').onclick = exportarServicios;
      const pf = ()=> LS.comp.barraFiltros(el.querySelector('#flt'), {defs:defsServ(), estado:st.serv, onCambio:txt=>{ if(!st.serv.estado) st.serv.estado = 'vigentes'; pt(); if(!txt) pf(); }});
      const pt = ()=>{ const c = el.querySelector('#tabla'); const filas = LS.comp.aplicarFiltros(D.servicios.map(s=>Object.assign(Object.create(s), {id:s.id, _inactivo:s.activo===false})), defsServ(), st.serv); const cols = colsServ();
        const g = LS.grid.render({id:'fact.serv', cols, filas, estado:st.gServ, vacio:'No hay servicios con estos filtros.', ordenClick:true});
        c.innerHTML = `<div class="grid-cuenta muted">${g.vis.length} servicio${g.vis.length===1?'':'s'}</div>` + g.html;
        LS.grid.cablear(c, {id:'fact.serv', cols, filas, estado:st.gServ, repintar:pt, ordenClick:true});
        c.querySelectorAll('[data-sv]').forEach(b=> b.onclick = ()=>formServicio(servDe(Number(b.dataset.sv))));
        c.querySelectorAll('[data-baja]').forEach(b=> b.onclick = ()=>bajaServicio(Number(b.dataset.baja)));
        c.querySelectorAll('[data-react]').forEach(b=> b.onclick = ()=>reactivar(Number(b.dataset.react)));
        c.querySelectorAll('[data-sdel]').forEach(b=> b.onclick = ()=>borrarServicio(Number(b.dataset.sdel))); };
      pf(); pt();
    }
    async function bajaServicio(id){
      const s = servDe(id); if(!s) return;
      let pend = 0; meses().forEach(k=> itemsMes(k).forEach(it=>{ if(it.servicioId===id && it.estado!=='enviado') pend++; }));
      const v = await ui.modal({titulo:'Dar de baja', html:`¿Dar de baja <b>${esc(s.cliente)}</b>${s.servicio?' · '+esc(s.servicio):''}? No se va a copiar a los períodos nuevos (se puede reactivar).${pend?`<br><br>Tiene <b>${pend}</b> línea(s) pendiente(s) en el seguimiento.`:''}`,
        botones:[{txt:'Cancelar', val:null}].concat(pend?[{txt:'Dar de baja y mover las pendientes a la Papelera', val:'pap'}]:[]).concat([{txt: pend?'Dar de baja y conservarlas':'Dar de baja', val:'ok', primary:true}])});
      if(!v) return;
      await guardar(d=>{ const x = d.servicios.find(y=>y.id===id); x.activo = false; x.recurrente = false;
        if(v==='pap'){ const e = []; Object.keys(d.meses).forEach(k=>{ d.meses[k].items.filter(it=>it.servicioId===id && it.estado!=='enviado').forEach(it=> e.push({tipo:'linea', mes:k, item:it, label:(s.cliente||'')+' · '+mesLabel(k)})); d.meses[k].items = d.meses[k].items.filter(it=>!(it.servicioId===id && it.estado!=='enviado')); }); papelera(d, e); } }, 'Dio de baja '+s.cliente);
      ui.toast('Servicio dado de baja'); repintar();
    }
    async function reactivar(id){
      const s = servDe(id); if(!s) return;
      if(!(await ui.confirmar(`¿Reactivar <b>${esc(s.cliente)}</b>${s.servicio?' · '+esc(s.servicio):''}? Se va a copiar a los períodos nuevos.`, {si:'Reactivar'}))) return;
      await guardar(d=>{ const x = d.servicios.find(y=>y.id===id); x.activo = true; x.recurrente = true; }, 'Reactivó '+s.cliente); repintar();
    }
    async function borrarServicio(id){
      const s = servDe(id); if(!s) return;
      let n = 0; meses().forEach(k=> itemsMes(k).forEach(it=>{ if(it.servicioId===id) n++; }));
      if(!(await ui.confirmar(`¿Eliminar <b>${esc(s.cliente)}</b>${s.servicio?' · '+esc(s.servicio):''} y sus ${n} línea(s)?<br><span class="muted">Va a la Papelera y se puede restaurar. Si solo querés que no se copie a períodos nuevos, usá "Dar de baja".</span>`, {si:'Eliminar', peligro:true}))) return;
      await guardar(d=>{ const items = []; Object.keys(d.meses).forEach(k=>{ d.meses[k].items.filter(it=>it.servicioId===id).forEach(it=> items.push({mes:k, item:it})); d.meses[k].items = d.meses[k].items.filter(it=>it.servicioId!==id); });
        const x = d.servicios.find(y=>y.id===id); d.servicios = d.servicios.filter(y=>y.id!==id); papelera(d, [{tipo:'servicio', servicio:x, items, label:(x.cliente||'')+(x.servicio?' · '+x.servicio:'')}]); }, 'Eliminó el servicio '+s.cliente);
      ui.toast('Servicio movido a la Papelera'); repintar();
    }

    /* ================= PAPELERA ================= */
    function vPapelera(){
      const p = (D.papelera||[]).slice().reverse().map(e=>Object.assign({}, e, {id:e.id, _e:e}));
      const cols = [
        {k:'label', l:'Elemento', w:'420px', val:e=>e.label||''},
        {k:'tipo', l:'Tipo', w:'110px', val:e=>e.tipo==='servicio'?'Servicio':'Línea'},
        {k:'ts', l:'Cuándo', w:'150px', val:e=>e.ts ? new Date(e.ts).toLocaleString('es-AR') : ''},
        {k:'por', l:'Quién', w:'110px', val:e=>e.por||''},
        {k:'acc', l:'', w:'110px', nofiltro:true, html:e=> RO() ? '' : `<button class="btn sm" data-rest="${esc(e.id)}">Restaurar</button>`}];
      const el = scroll(LS.comp.encabezado('Papelera', `${p.length} elemento${p.length===1?'':'s'} borrado${p.length===1?'':'s'} · se guardan los últimos 300`, RO()||!p.length ? '' : `<button class="btn danger" data-a="vaciar">${I('trash')} Vaciar papelera</button>`) + '<div id="tabla"></div>', 'pap');
      const pt = ()=>{ const c = el.querySelector('#tabla'); const g = LS.grid.render({id:'fact.pap', cols, filas:p, estado:st.gPap, vacio:'La papelera está vacía.', ordenClick:true}); c.innerHTML = g.html;
        LS.grid.cablear(c, {id:'fact.pap', cols, filas:p, estado:st.gPap, repintar:pt, ordenClick:true});
        c.querySelectorAll('[data-rest]').forEach(b=> b.onclick = async ()=>{ const e = (D.papelera||[]).find(x=>x.id===b.dataset.rest); if(!e) return; await guardar(d=>{ const x = d.papelera.find(y=>y.id===e.id); if(x) restaurar(d, x); }, 'Restauró de la Papelera: '+(e.label||'')); ui.toast('Restaurado: '+(e.label||'')); vPapelera(); }); };
      const bv = el.querySelector('[data-a="vaciar"]'); if(bv) bv.onclick = async ()=>{ if(await ui.confirmar('¿Vaciar la papelera? Lo que está acá ya no se va a poder recuperar (salvo desde un backup).', {si:'Vaciar', peligro:true})){ await guardar(d=>{ d.papelera = []; }, 'Vació la papelera de Facturación'); vPapelera(); } };
      pt();
    }

    /* ================= ABRIR PERÍODO ================= */
    async function abrirPeriodo(){
      if(RO()) return;
      const ult = meses().slice(-1)[0]; const next = ult ? addMes(ult, 1) : ui.hoy().slice(0,7);
      const palabra = mesLabel(next).split(' ')[0].toUpperCase();
      const v = await ui.modal({titulo:'Abrir período '+mesLabel(next), html:`<p style="margin-top:0">Se crea el listado de <b>${esc(mesLabel(next))}</b> con los servicios recurrentes que ya iniciaron. El período de cada uno sale de su modalidad:</p>
        <ul><li>Mes vencido → ${esc(mesLabel(next))}</li><li>Mes en curso → ${esc(mesLabel(addMes(next,1)))}</li></ul>
        <p>Los servicios con la fecha de baja cumplida se dan de baja solos. Se hace <b>una sola vez por período</b>.</p>
        <div class="field"><label>Para confirmar, escribí <b>${esc(palabra)}</b></label><input class="inp" id="pP" autocomplete="off"></div>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Abrir período', primary:true, val:true, validar:ov=>{ if(ov.querySelector('#pP').value.trim().toUpperCase()!==palabra){ ui.toast('La palabra no coincide: no se abrió el período.'); return false; } return true; }}]});
      if(!v) return;
      const r = await guardar(d=>{
        if(d.meses[next]) return {ya:true};
        const bajas = [];
        d.servicios.forEach(s=>{ if(s.activo && s.fechaBaja && !servicioVigenteEn(s, next)){ s.activo = false; s.recurrente = false; bajas.push(s.cliente); } });
        d.meses[next] = {items: d.servicios.filter(s=>s.activo && s.recurrente!==false && servicioActivoEn(s, next) && servicioVigenteEn(s, next)).map(s=>{
          const fact = factDe(s, next); const prop = s.fechaBaja && s.fechaBaja.slice(0,7)===fact;
          return {id:ui.uid('l'), servicioId:s.id, estado:'', facturacionMes:fact, fechaEnvio:'', notas: prop ? 'BAJA el '+fmtF(s.fechaBaja)+': facturar proporcional' : ''}; })};
        return {n:d.meses[next].items.length, bajas};
      }, 'Abrió el período '+mesLabel(next));
      if(!r) return;
      st.mes = next;
      ui.alerta(r.ya ? 'Ese período ya estaba abierto.' : `Se abrió <b>${esc(mesLabel(next))}</b> con ${r.n} servicios.${r.bajas.length?'<br><br>Se dieron de baja solos (fecha de baja cumplida): '+esc(r.bajas.join(', ')):''}`, 'Período abierto');
      render(); ctx.refrescarMenu();
    }

    /* ================= ESTADO GENERAL ================= */
    function irSeguimiento(filtros){
      st.seg = Object.assign({mostrar:'actual_ant'}, filtros); st.gSeg.filtros = {};
      st.sec = 'seguimiento'; ctx.setSeccion('seguimiento'); render();
    }
    function vEstado(){
      if(!st.mes) return vVacio();
      const filas = filasSeg(st.mes, 'actual_ant');
      const actual = filas.filter(r=>!r.back), back = filas.filter(r=>r.back);
      const pend = filas.filter(r=>r.it.estado!=='enviado'), env = actual.filter(r=>r.it.estado==='enviado');
      const falt = filas.filter(r=>r.it.estado!=='enviado' && faltantes(r.s, r.it).length);
      const clientesPend = new Set(pend.map(r=>r.s.cliente)).size;
      const pct = actual.length ? Math.round(env.length*100/actual.length) : 0;
      const k1 = [
        {k:'pend', n:pend.length, l:'Por facturar / enviar', sub:`${clientesPend} cliente${clientesPend===1?'':'s'}`, tono:pend.length?'danger':'ok', icono:'receipt', click:()=>irSeguimiento({soloPend:true})},
        {k:'back', n:back.length, l:'Pendientes de períodos anteriores', sub: back.length?'Todavía sin enviar':'Al día', tono:back.length?'warn':'ok', icono:'history', click:()=>irSeguimiento({mostrar:'solo_ant'})},
        {k:'falt', n:falt.length, l:'Con datos faltantes', sub:'CUIT, pedido, OC, contactos…', tono:falt.length?'warn':'ok', icono:'alert', click:()=>irSeguimiento({faltantes:true, soloPend:true})},
        {k:'env', n:env.length, l:'Enviadas del período', sub:`${pct}% de ${actual.length} facturas`, tono:'ok', icono:'check', click:()=>irSeguimiento({estado:'enviado', mostrar:'actual'})}];
      const k2 = ESTADOS.map(([e,l,t])=>{ const n = (e==='enviado' ? env : filas).filter(r=>(r.it.estado||'')===e).length; return {k:'e:'+e, n, l, tono:t, click:()=>irSeguimiento(e==='enviado' ? {estado:'enviado', mostrar:'actual'} : {estado:e||'__sin__'})}; });
      const porResp = {}; pend.forEach(r=>{ const g = partesResp(r.s.responsable).gerente; porResp[g] = (porResp[g]||0)+1; });
      const resps = Object.entries(porResp).sort((a,b)=>b[1]-a[1]); const max = Math.max(1, ...resps.map(x=>x[1]));
      const el = scroll(LS.comp.encabezado('Estado general', 'Período <b>'+esc(mesLabel(st.mes))+'</b> y pendientes de períodos anteriores. Tocá una tarjeta para ver el detalle en el Seguimiento.',
        `<label class="flt"><span>Período</span><select class="inp" id="eMes">${meses().slice().reverse().map(k=>`<option value="${k}" ${k===st.mes?'selected':''}>${esc(mesLabel(k))}</option>`).join('')}</select></label>${RO()?'':`<button class="btn" data-a="per">${I('plus')} Abrir período</button>`}`) +
        LS.comp.kpis(k1) + '<h3 class="sec-t">Por estado</h3>' + LS.comp.kpis(k2) +
        `<div class="split"><div class="box"><h3>${I('users')} Pendientes por gerente</h3>${resps.length ? resps.map(([g,n])=>`<div class="bar-row click" data-resp="${esc(g)}"><span class="bar-lbl">${esc(g)}</span><span class="bar-track"><span class="bar" style="width:${Math.max(4, n*100/max)}%"></span></span><span class="bar-val">${n}</span></div>`).join('') : '<div class="empty">Nada pendiente.</div>'}</div>
          <div class="box"><h3>${I('alert')} Datos faltantes por servicio</h3>${falt.length ? `<table class="grid"><thead><tr><th>Cliente</th><th>Falta</th><th></th></tr></thead><tbody>${falt.slice(0,40).map(r=>`<tr><td><b>${esc(r.s.cliente)}</b><div class="muted sm">${esc((r.s.servicio||'').slice(0,70))}</div></td><td>${faltantes(r.s, r.it).map(x=>`<span class="chip t-danger">${esc(x)}</span>`).join(' ')}</td><td><button class="btn sm" data-comp="${esc(r.id)}">${RO()?'Ver':'Completar'}</button></td></tr>`).join('')}</tbody></table>${falt.length>40?`<div class="muted sm">y ${falt.length-40} más: verlos en el Seguimiento.</div>`:''}` : '<div class="empty">No hay datos faltantes.</div>'}</div></div>`, 'est');
      LS.comp.cablearKpis(el, k1.concat(k2));
      el.querySelector('#eMes').onchange = e=>{ st.mes = e.target.value; vEstado(); };
      const bp = el.querySelector('[data-a="per"]'); if(bp) bp.onclick = abrirPeriodo;
      el.querySelectorAll('[data-resp]').forEach(b=> b.onclick = ()=> irSeguimiento({soloPend:true, gerente:b.dataset.resp}));
      el.querySelectorAll('[data-comp]').forEach(b=> b.onclick = ()=>{ const x = buscarItem(D, b.dataset.comp); if(x) formServicio(servDe(x.it.servicioId), x); });
    }
    function vVacio(){ scroll(`<div class="empty">${I('receipt')}<br>Todavía no hay períodos abiertos.${RO()?'':` <button class="btn primary" id="pp">Abrir el primero</button>`}</div>`); const b = root.querySelector('#pp'); if(b) b.onclick = abrirPeriodo; }

    /* ================= CIERRE Y RESUMEN POR GERENTE ================= */
    function filasCierre(){
      const claves = st.cierreMes==='todos' ? meses() : [st.cierreMes];
      const rows = [];
      claves.forEach(mes=> itemsMes(mes).forEach(it=>{ const s = servDe(it.servicioId); if(s && s.activo!==false) rows.push({id:it.id, it, mes, s}); }));
      return rows;
    }
    const cierreLabel = () => st.cierreMes==='todos' ? 'todos los períodos' : mesLabel(st.cierreMes);
    const mailGerente = g => { const mm = D.config.responsablesMail || {}; if(mm[g]) return mm[g]; const k = Object.keys(mm).find(k=>partesResp(k).gerente===g && mm[k]); return k ? mm[k] : ''; };
    const SEC_DEF = [['pend','FACTURACIÓN PENDIENTE'],['oc','PENDIENTES DE OC'],['verif','INFORMACIÓN PENDIENTE']];
    function estructuraResumen(gerente){
      const target = st.cierreMes==='todos' ? (meses().slice(-1)[0]||'') : st.cierreMes;
      const rows = [];
      meses().forEach(mes=>{ if(mes > target) return; itemsMes(mes).forEach(it=>{ const s = servDe(it.servicioId); if(s && s.activo!==false && partesResp(s.responsable).gerente===gerente) rows.push({it, mes, s}); }); });
      const ord = arr => arr.sort((a,b)=>(a.it.facturacionMes||'9999').localeCompare(b.it.facturacionMes||'9999') || (a.s.cliente||'').localeCompare(b.s.cliente||'','es'));
      const clasif = arr => ({
        pend: ord(arr.filter(r=>{ const e = r.it.estado||''; return e && !['enviado','pendiente OC','oc solicitada','informacion pendiente','pendiente aprobacion'].includes(e); })),
        oc: ord(arr.filter(r=>r.it.estado==='pendiente OC' || r.it.estado==='oc solicitada')),
        verif: ord(arr.filter(r=>r.it.estado==='informacion pendiente'))});
      const blocks = []; const solos = rows.filter(r=>!partesResp(r.s.responsable).supervisor);
      if(solos.length) blocks.push({sup:'', secs:clasif(solos)});
      const porSup = {}; rows.forEach(r=>{ const sp = partesResp(r.s.responsable).supervisor; if(sp) (porSup[sp] = porSup[sp] || []).push(r); });
      Object.keys(porSup).sort().forEach(sp=> blocks.push({sup:sp, secs:clasif(porSup[sp])}));
      return {target, blocks};
    }
    function resumenTexto(g){
      const est = estructuraResumen(g); const partes = [];
      est.blocks.forEach(b=>{ const ind = b.sup ? '  ' : ''; const t = [];
        SEC_DEF.forEach(([k,tit])=>{ const arr = b.secs[k]; if(arr.length) t.push(ind+'▸ '+tit+'\n'+arr.map(r=>`${ind}  • ${r.s.cliente}${r.s.servicio?' — '+r.s.servicio:''}\n${ind}      ${r.it.facturacionMes?mesLabel(r.it.facturacionMes):'sin período'} · ${r.s.empresa||'s/empresa'}${(r.s.observaciones||'').trim()?'\n'+ind+'      Obs: '+r.s.observaciones.trim():''}`).join('\n')); });
        if(t.length) partes.push(b.sup ? '══════ SUPERVISIÓN: '+b.sup.toUpperCase()+' ══════\n\n'+t.join('\n\n') : t.join('\n\n')); });
      return partes.join('\n\n\n') || '(sin facturas pendientes en este período)';
    }
    function resumenHTML(g){
      const est = estructuraResumen(g); const per = est.target ? mesLabel(est.target) : 'pendiente';
      let out = `<div style="font:14px/1.45 Arial,Helvetica,sans-serif;color:#111">Hola ${esc(g)},<br><br><span style="font-size:15px"><b>Resumen de facturación: ${esc(per)}</b></span>`;
      est.blocks.forEach(b=>{ let bl = '';
        SEC_DEF.forEach(([k,tit])=>{ const arr = b.secs[k]; if(arr.length) bl += `<div style="font-weight:bold;color:#1f4e8c;margin:10px 0 2px">▸ ${tit}</div><ul style="margin:0;padding-left:22px">${arr.map(r=>`<li style="margin:3px 0"><b>${esc(r.s.cliente)}</b>${r.s.servicio?' — '+esc(r.s.servicio):''}<br><span style="color:#555">${esc((r.it.facturacionMes?mesLabel(r.it.facturacionMes):'sin período')+' · '+(r.s.empresa||'s/empresa'))}</span>${(r.s.observaciones||'').trim()?`<br><span style="color:#8a5a00">Obs: ${esc(r.s.observaciones.trim())}</span>`:''}</li>`).join('')}</ul>`; });
        if(bl){ if(b.sup) out += `<div style="font-weight:bold;font-size:15px;margin:16px 0 4px;border-bottom:2px solid #1f4e8c">SUPERVISIÓN: ${esc(b.sup)}</div>`; out += bl; } });
      return out + '<br>Saludos.</div>';
    }
    function vCierre(){
      if(!st.mes) return vVacio();
      if(!st.cal){ const d = new Date(); st.cal = {y:d.getFullYear(), m:d.getMonth()}; }
      const rows = filasCierre(); const pend = rows.filter(r=>r.it.estado!=='enviado');
      const sinFecha = pend.filter(r=>!r.it.fechaCierre), sinEstado = rows.filter(r=>!r.it.estado);
      const {y, m} = st.cal; const first = new Date(y, m, 1); const start = (first.getDay()+6)%7; const dias = new Date(y, m+1, 0).getDate(); const hoy = ui.hoy();
      let cells = ''; for(let i=0;i<start;i++) cells += '<div class="cal-d otro"></div>';
      for(let d=1; d<=dias; d++){ const iso = y+'-'+String(m+1).padStart(2,'0')+'-'+String(d).padStart(2,'0'); const dd = pend.filter(r=>r.it.fechaCierre===iso);
        cells += `<div class="cal-d ${iso===hoy?'hoy':''} click" data-dia="${iso}"><div class="cal-n">${d}</div>${dd.slice(0,4).map(r=>`<div class="cal-ev todos" title="${esc(r.s.cliente)}">${esc(r.s.cliente)}</div>`).join('')}${dd.length>4?`<div class="muted" style="font-size:11px">+${dd.length-4} más</div>`:''}</div>`; }
      const porG = {}; rows.forEach(r=>{ const g = partesResp(r.s.responsable).gerente; (porG[g] = porG[g] || []).push(r); });
      const gs = Object.keys(porG).sort((a,b)=>a.localeCompare(b,'es')); const pG = {}; gs.forEach(g=> pG[g] = porG[g].filter(r=>r.it.estado!=='enviado').length);
      const max = Math.max(1, ...Object.values(pG));
      const el = scroll(LS.comp.encabezado('Cierre y resumen por gerente', `Facturas pendientes de <b>${esc(cierreLabel())}</b> (servicios activos). Tocá un día para asignar qué se factura ese día.`,
        `<label class="flt"><span>Período</span><select class="inp" id="cMes"><option value="todos">Todos</option>${meses().slice().reverse().map(k=>`<option value="${k}" ${k===st.cierreMes?'selected':''}>${esc(mesLabel(k))}</option>`).join('')}</select></label>
         <button class="btn" data-a="xls">${I('excel')} Excel</button><button class="btn" data-a="print">${I('file')} Imprimir / PDF</button>`) +
        (sinEstado.length ? `<div class="banner danger" style="border-radius:8px;margin-bottom:10px">${I('alert')}<span class="grow">Hay <b>${sinEstado.length}</b> factura(s) <b>sin estado</b> en ${esc(cierreLabel())}: no salen en el mail al gerente.</span><button class="btn sm" data-a="sinest">Clasificar ahora</button></div>` : '') +
        `<div class="toolbar"><button class="btn sm" data-cal="-1">‹</button><b style="min-width:150px;text-align:center">${MESES[m]} ${y}</b><button class="btn sm" data-cal="1">›</button><button class="btn sm" data-cal="0">Hoy</button></div>
        <div class="cal-grid">${['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'].map(d=>`<div class="cal-h">${d}</div>`).join('')}${cells}</div>
        <div class="box" style="margin-top:14px"><h3>${I('calendar')} Pendientes sin fecha de cierre (${sinFecha.length})</h3>${sinFecha.length ? `<table class="grid"><thead><tr><th>Cliente / servicio</th><th>Período</th><th>Responsable</th><th>Estado</th><th>Fecha de cierre</th></tr></thead><tbody>${sinFecha.sort((a,b)=>(a.s.cliente||'').localeCompare(b.s.cliente||'','es')).map(r=>`<tr><td><b>${esc(r.s.cliente)}</b><div class="muted sm">${esc((r.s.servicio||'').slice(0,80))}</div></td><td>${esc(mesLabel(r.it.facturacionMes))}</td><td>${esc(r.s.responsable||'')}</td><td>${LS.comp.estado(estLabel(r.it.estado), estTono(r.it.estado))}</td><td>${RO()?'':`<input class="inp" type="date" data-fc="${esc(r.id)}" style="width:150px">`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Todas las pendientes tienen fecha de cierre.</div>'}</div>
        <div class="split"><div class="box"><h3>${I('mail')} Resumen por gerente</h3>
          <div class="field"><label>Enviar desde (cuenta de Outlook web)</label><input class="inp" type="email" id="cCta" value="${esc(D.config.cuentaEnvio || auth.user.email || '')}" ${RO()?'disabled':''} style="max-width:320px"></div>
          <table class="grid"><thead><tr><th>Gerente</th><th>Pendientes</th><th>Mail</th><th></th></tr></thead><tbody>${gs.map((g,i)=>`<tr><td><b>${esc(g)}</b></td><td>${LS.comp.estado(String(pG[g]), pG[g]?'warn':'ok')}</td><td><input class="inp" type="email" data-gm="${i}" value="${esc(mailGerente(g))}" placeholder="gerente@empresa.com" ${RO()?'disabled':''}></td>
            <td><div class="acc"><button class="btn sm" data-out="${i}">${I('mail')} Outlook web</button><button class="btn sm" data-cop="${i}">${I('clipboard')} Copiar con formato</button></div></td></tr>`).join('')}</tbody></table></div>
          <div class="box"><h3>${I('chart')} Pendientes por gerencia</h3>${gs.map(g=>`<div class="bar-row"><span class="bar-lbl">${esc(g)}</span><span class="bar-track"><span class="bar" style="width:${pG[g]?Math.max(4,pG[g]*100/max):0}%"></span></span><span class="bar-val">${pG[g]||'✓'}</span></div>`).join('') || '<div class="empty">Sin datos</div>'}</div></div>`, 'cie');
      el.querySelector('#cMes').onchange = e=>{ st.cierreMes = e.target.value; vCierre(); };
      el.querySelectorAll('[data-cal]').forEach(b=> b.onclick = ()=>{ const v = +b.dataset.cal; if(!v){ const d = new Date(); st.cal = {y:d.getFullYear(), m:d.getMonth()}; } else { let mm = st.cal.m+v, yy = st.cal.y; if(mm<0){ mm=11; yy--; } if(mm>11){ mm=0; yy++; } st.cal = {y:yy, m:mm}; } vCierre(); });
      el.querySelectorAll('[data-dia]').forEach(c=> c.onclick = ()=>diaCierre(c.dataset.dia));
      el.querySelectorAll('[data-fc]').forEach(i=> i.onchange = async ()=>{ const x = buscarItem(D, i.dataset.fc); await guardar(d=>{ const y2 = buscarItem(d, i.dataset.fc); if(y2) y2.it.fechaCierre = i.value; }, 'Fecha de cierre '+(x?servDe(x.it.servicioId).cliente:'')+': '+fmtF(i.value)); vCierre(); });
      const cc = el.querySelector('#cCta'); if(cc) cc.onchange = ()=>guardar(d=>{ d.config.cuentaEnvio = cc.value.trim(); }, 'Cuenta de envío: '+cc.value.trim());
      el.querySelectorAll('[data-gm]').forEach(i=> i.onchange = ()=>{ const g = gs[+i.dataset.gm]; guardar(d=>{ d.config.responsablesMail = d.config.responsablesMail || {}; d.config.responsablesMail[g] = i.value.trim(); }, 'Mail de '+g); });
      el.querySelectorAll('[data-out]').forEach(b=> b.onclick = ()=>{ const g = gs[+b.dataset.out]; const per = estructuraResumen(g).target; const asunto = 'Resumen de facturación '+(per?mesLabel(per):'')+' — '+g;
        const cuerpo = 'Hola '+g+',\n\nResumen de facturación ('+(per?mesLabel(per):'pendiente')+'):\n\n'+resumenTexto(g)+'\n\nSaludos.';
        const from = (D.config.cuentaEnvio || auth.user.email || '').trim();
        sys.open('https://outlook.office.com/mail/deeplink/compose?to='+encodeURIComponent(mailGerente(g))+'&subject='+encodeURIComponent(asunto)+'&body='+encodeURIComponent(cuerpo)+(from?'&login_hint='+encodeURIComponent(from):'')).catch(e=>ui.alerta(esc(sys.errMsg(e)))); LS.log('facturacion', 'Abrió el resumen para '+g); });
      el.querySelectorAll('[data-cop]').forEach(b=> b.onclick = async ()=>{ const g = gs[+b.dataset.cop]; const html = resumenHTML(g), txt = resumenTexto(g);
        try{ await navigator.clipboard.write([new ClipboardItem({'text/html':new Blob([html],{type:'text/html'}), 'text/plain':new Blob([txt],{type:'text/plain'})})]); ui.toast('Copiado con formato: pegalo en el cuerpo del mail (Ctrl+V).'); }
        catch(e){ LS.comp.ventana({titulo:'Resumen · '+g, html:`<p class="muted" style="margin-top:0">Seleccioná todo (Ctrl+A dentro del recuadro), copiá y pegá en el mail.</p><div class="box" contenteditable="true" style="max-height:60vh;overflow:auto">${html}</div>`}); } });
      el.querySelector('[data-a="xls"]').onclick = exportarCierre;
      el.querySelector('[data-a="print"]').onclick = imprimirCierre;
      const bs = el.querySelector('[data-a="sinest"]'); if(bs) bs.onclick = ()=>irSeguimiento({estado:'__sin__', mostrar:'actual_ant'});
    }
    async function diaCierre(iso){
      const tgt = st.cierreMes!=='todos' ? st.cierreMes : st.mes;
      const pinta = ()=>{ const en = filasCierre().filter(r=>r.it.fechaCierre===iso && r.it.estado!=='enviado');
        return en.length ? `<table class="grid"><tbody>${en.map(r=>`<tr><td><b>${esc(r.s.cliente)}</b><div class="muted sm">${esc((r.s.servicio||'').slice(0,70))} · ${esc(mesLabel(r.it.facturacionMes||r.mes))}</div></td><td style="text-align:right">${RO()?'':`<button class="btn sm" data-q="${esc(r.id)}">Quitar</button>`}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Sin facturas asignadas a este día.</div>'; };
      const act = D.servicios.filter(s=>s.activo!==false).sort((a,b)=>(a.cliente||'').localeCompare(b.cliente||'','es'));
      await ui.modal({titulo:'Cierre del '+fmtF(iso), html:`<div id="dL">${pinta()}</div>${RO()?'':`<div class="field" style="margin-top:12px"><label>Agregar un servicio a este día (período ${esc(mesLabel(tgt))})</label><div class="row"><select class="inp" id="dS" style="flex:1"><option value="">— Elegí un servicio —</option>${act.map(s=>`<option value="${s.id}">${esc(s.cliente)} · ${esc((s.servicio||'').slice(0,55))}</option>`).join('')}</select><button class="btn primary" id="dA">Agregar</button></div></div>`}`,
        botones:[{txt:'Cerrar', val:null, primary:true}], onOpen: ov=>{
          const cab = ()=>{ ov.querySelector('#dL').innerHTML = pinta(); ov.querySelectorAll('[data-q]').forEach(b=> b.onclick = async ()=>{ await guardar(d=>{ const y = buscarItem(d, b.dataset.q); if(y) y.it.fechaCierre = ''; }, 'Quitó una fecha de cierre'); cab(); }); };
          cab(); const a = ov.querySelector('#dA'); if(a) a.onclick = async ()=>{ const sid = Number(ov.querySelector('#dS').value); if(!sid) return ui.toast('Elegí un servicio.');
            await guardar(d=>{ d.meses[tgt] = d.meses[tgt] || {items:[]}; let it = d.meses[tgt].items.find(x=>x.servicioId===sid); const s = d.servicios.find(x=>x.id===sid);
              if(!it){ it = {id:ui.uid('l'), servicioId:sid, estado:'', facturacionMes:factDe(s, tgt), fechaEnvio:'', notas:''}; d.meses[tgt].items.push(it); } it.fechaCierre = iso; }, 'Asignó cierre '+fmtF(iso)); cab(); };
        }});
      vCierre();
    }

    /* ================= EXPORTACIONES ================= */
    function exportarSeguimiento(){
      const filas = LS.grid.render({cols:colsSeg(), filas:filasVisibles(), estado:st.gSeg}).vis;
      if(!filas.length) return ui.toast('No hay líneas para exportar con estos filtros.');
      const filtros = [['Período', mesLabel(st.mes)], ['Mostrar', {actual_ant:'Período + pendientes anteriores', actual:'Solo el período', solo_ant:'Solo pendientes anteriores'}[st.seg.mostrar||'actual_ant']]]
        .concat(LS.comp.describirFiltros(defsSeg().filter(d=>!d.noFiltra), st.seg, colsSeg(), st.gSeg));
      LS.comp.exportar({archivo:'Seguimiento de facturacion '+mesLabel(st.mes)+'.xlsx', hoja:'Seguimiento', filtros, filas, cols:[
        {l:'Cliente', w:30, v:r=>r.s.cliente}, {l:'Servicio', w:45, v:r=>r.s.servicio}, {l:'Empresa', w:18, v:r=>r.s.empresa}, {l:'Responsable', w:24, v:r=>r.s.responsable},
        {l:'Período', w:15, v:r=>mesLabel(r.it.facturacionMes)}, {l:'Línea de', w:15, v:r=>mesLabel(r.mes)}, {l:'Estado', w:24, v:r=>estLabel(r.it.estado)},
        {l:'Fecha de envío', w:14, v:r=>fmtF(r.it.fechaEnvio)}, {l:'Notas del período', w:60, v:r=>unaLinea(r.it.notas)}, {l:'Datos faltantes', w:30, v:r=>faltantes(r.s, r.it).join(', ')},
        {l:'Observaciones', w:40, v:r=>unaLinea(r.s.observaciones)}, {l:'Modalidad de incremento', w:22, v:r=>r.s.modalidadIncremento ? r.s.modalidadIncremento+(r.s.esquemaIncremento?' ('+r.s.esquemaIncremento+')':'') : ''}]});
    }
    function exportarServicios(){
      const filas = LS.grid.render({cols:colsServ(), filas:LS.comp.aplicarFiltros(D.servicios.map(s=>Object.assign(Object.create(s), {id:s.id})), defsServ(), st.serv), estado:st.gServ}).vis;
      LS.comp.exportar({archivo:'Servicios de facturacion '+ui.hoy()+'.xlsx', hoja:'Servicios', filas, filtros:LS.comp.describirFiltros(defsServ(), st.serv, colsServ(), st.gServ), cols:[
        {l:'Cliente', w:30, v:s=>s.cliente}, {l:'Servicio', w:45, v:s=>s.servicio}, {l:'Empresa', w:18, v:s=>s.empresa}, {l:'Responsable', w:24, v:s=>s.responsable},
        {l:'Requiere OC', w:12, v:s=>s.requiereOC?'Sí':'No'}, {l:'Modalidad', w:14, v:s=>s.modalidad==='encurso'?'Mes en curso':'Mes vencido'}, {l:'CUIT', w:16, v:s=>s.cuit}, {l:'Pedido', w:16, v:s=>s.pedido},
        {l:'Orden de compra', w:18, v:s=>s.ordenCompra}, {l:'Contactos', w:40, v:s=>s.porPortal?'(portal)':s.contactosPara}, {l:'Inicio', w:12, v:s=>fmtF(s.fechaInicio)}, {l:'Baja', w:12, v:s=>fmtF(s.fechaBaja)},
        {l:'Estado', w:10, v:s=>s.activo===false?'Baja':'Vigente'}, {l:'Faltan', w:30, v:s=>s.activo===false?'':faltantes(s).join(', ')}, {l:'Observaciones', w:40, v:s=>unaLinea(s.observaciones)}]});
    }
    const colsCierre = [{l:'Cliente', w:30, v:r=>r.s.cliente}, {l:'Servicio', w:45, v:r=>r.s.servicio}, {l:'Empresa', w:18, v:r=>r.s.empresa}, {l:'Responsable', w:24, v:r=>r.s.responsable},
      {l:'Período', w:15, v:r=>mesLabel(r.it.facturacionMes)}, {l:'Estado', w:24, v:r=>estLabel(r.it.estado)}, {l:'Modalidad', w:14, v:r=>r.s.modalidad==='encurso'?'Mes en curso':'Mes vencido'}, {l:'Fecha de cierre', w:14, v:r=>fmtF(r.it.fechaCierre)}];
    const filasCierreOrd = () => filasCierre().filter(r=>r.it.estado!=='enviado').sort((a,b)=>(a.it.fechaCierre||'9999').localeCompare(b.it.fechaCierre||'9999') || (a.s.cliente||'').localeCompare(b.s.cliente||'','es'));
    function exportarCierre(){ LS.comp.exportar({archivo:'Cierre de facturacion '+(st.cierreMes==='todos'?'todos':mesLabel(st.cierreMes))+'.xlsx', hoja:'Cierre', filas:filasCierreOrd(), cols:colsCierre, filtros:[['Período', cierreLabel()], ['Incluye', 'Solo pendientes (sin enviar) de servicios activos']]}); }
    function imprimirCierre(){
      const f = filasCierreOrd();
      LS.comp.imprimir('Cierre de facturación · '+cierreLabel(), `<table><thead><tr>${colsCierre.map(c=>`<th>${esc(c.l)}</th>`).join('')}</tr></thead><tbody>${f.map(r=>`<tr>${colsCierre.map(c=>`<td>${esc(c.v(r)||'')}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
    }

    /* ================= IMPORTAR FACTURAS EMITIDAS (1.0.15) =================
       Excel "APROBACION DE FC" del sistema de facturación (Cliente, Tipo, Nro., Fecha, Pedido, Moneda, Debe, Autorizado, Rechazado).
       Cada factura se enlaza por su PEDIDO con el servicio que tiene ese pedido cargado; la línea del seguimiento que todavía no se
       envió pasa a "Lista para enviar" (con una nota con el nº de factura). Lo que no se encuentra se informa y se puede exportar. */
    const pedKey = v => { const g = String(v||'').match(/\d+/g); if(!g || g.length<2) return null; return Number(g[g.length-2])+'-'+Number(g[g.length-1]); };
    const cargarXlsx = () => new Promise((res, rej)=>{ if(window.XLSX) return res(window.XLSX); const s = document.createElement('script'); s.src = 'lib/xlsx.full.min.js'; s.onload = ()=>res(window.XLSX); s.onerror = ()=>rej('No se pudo cargar la librería de Excel'); document.head.appendChild(s); });
    const isoDe = v => { if(v instanceof Date && !isNaN(v)) return v.getFullYear()+'-'+String(v.getMonth()+1).padStart(2,'0')+'-'+String(v.getDate()).padStart(2,'0');
      const m = String(v||'').match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/); if(m) return m[3]+'-'+m[2].padStart(2,'0')+'-'+m[1].padStart(2,'0'); const m2 = String(v||'').match(/(\d{4})-(\d{2})-(\d{2})/); return m2 ? m2[0] : ''; };
    const siNo = v => v===true || /^(true|verdadero|si|sí|1|x)$/i.test(String(v||'').trim());
    async function leerAprobadas(f){
      const X = await cargarXlsx(); const wb = X.read(await sys.readBytes(f), {type:'array', cellDates:true});
      const ws = wb.Sheets[wb.SheetNames.find(n=>/aprob/i.test(n)) || wb.SheetNames[0]];
      const filas = X.utils.sheet_to_json(ws, {defval:'', raw:true});
      const col = (r, ...ns) => { const k = Object.keys(r).find(k=> ns.some(n=> ui.norm(k).replace(/[^a-z]/g,'')===n)); return k ? r[k] : ''; };
      return filas.map(r=>({cliente:String(col(r,'cliente')).trim(), tipo:String(col(r,'tipo')).trim(), nro:String(col(r,'nro','numero','nrocomprobante')).trim(), fecha:isoDe(col(r,'fecha')),
        pedido:String(col(r,'pedido')).trim(), moneda:String(col(r,'moneda')).trim(), importe:Number(col(r,'debe','importe','total'))||0, autorizado:siNo(col(r,'autorizado')), rechazado:siNo(col(r,'rechazado'))}))
        .filter(r=>r.nro || r.pedido);
    }
    function enlazarAprobadas(lista){
      const idx = {}, idxN = {}; D.servicios.forEach(s=>{ const k = pedKey(s.pedido); if(k){ (idx[k] = idx[k] || []).push(s); const n = k.split('-')[1]; (idxN[n] = idxN[n] || []).push(s); } });
      const usados = new Set();
      return lista.map(r=>{
        const o = Object.assign({}, r, {key:pedKey(r.pedido), cands:[], elegido:'', res:'', det:''});
        if(!/factura/i.test(r.tipo||'Factura')){ o.res = 'otro'; o.det = 'No es factura ('+r.tipo+')'; return o; }
        if(r.rechazado){ o.res = 'rechazada'; o.det = 'Rechazada en el sistema de facturación'; return o; }
        if(!o.key){ o.res = 'sinPedido'; o.det = 'La factura no tiene un pedido legible'; return o; }
        let svs = idx[o.key] || [];
        // mismo número de pedido con otro punto de venta (ej. 00004 en el Excel y 00003 en el sistema): se enlaza y se avisa
        if(!svs.length && idxN[o.key.split('-')[1]]){ svs = idxN[o.key.split('-')[1]]; o.aviso = 'Mismo nº de pedido con otro punto de venta (en el sistema: '+[...new Set(svs.map(s=>s.pedido))].join(', ')+')'; }
        if(!svs.length){ o.res = 'sinPedido'; o.det = 'Ningún servicio tiene cargado el pedido '+r.pedido; return o; }
        o.servs = svs;
        const emi = (r.fecha||ui.hoy()).slice(0,7);
        meses().forEach(k=> itemsMes(k).forEach(it=>{ const s = svs.find(x=>x.id===it.servicioId); if(s && it.estado!=='enviado') o.cands.push({id:it.id, it, s, mes:k, per:it.facturacionMes||k}); }));
        // primero la línea del mes que corresponde a la fecha de la factura (mes vencido o en curso), después las más recientes
        const esperado = s => s.modalidad==='encurso' ? emi : addMes(emi, -1);
        o.cands.sort((a,b)=> (b.per===esperado(b.s)) - (a.per===esperado(a.s)) || (a.it.estado==='lista para enviar') - (b.it.estado==='lista para enviar') || b.per.localeCompare(a.per));
        const libre = o.cands.find(c=>!usados.has(c.id));
        if(!libre){ const env = []; meses().forEach(k=> itemsMes(k).forEach(it=>{ if(svs.some(s=>s.id===it.servicioId) && it.estado==='enviado') env.push(it); }));
          o.res = o.cands.length ? 'repetida' : (env.length ? 'yaEnviada' : 'sinLinea');
          o.det = (o.aviso ? o.aviso+'. ' : '') + (o.cands.length ? 'Otra factura del Excel ya tomó la línea pendiente de este pedido' : env.length ? 'La línea de este pedido ya figura como enviada' : 'El pedido existe pero no hay una línea pendiente en el seguimiento');
          return o; }
        usados.add(libre.id); o.elegido = libre.id; if(o.aviso) o.det = o.aviso;
        o.res = libre.it.estado==='lista para enviar' ? 'yaLista' : 'marcar';
        return o; });
    }
    const RES = {marcar:['Se marca "Listo para enviar"','brand'], yaLista:['Ya estaba lista para enviar','neutro'], yaEnviada:['Ya enviada','ok'], sinPedido:['Pedido no encontrado','danger'], sinLinea:['Sin línea pendiente','warn'], repetida:['Pedido repetido','warn'], rechazada:['Rechazada','neutro'], otro:['No es factura','neutro']};
    const candTxt = c => `${c.s.cliente} · ${(c.s.servicio||'').slice(0,50)} · ${mesLabel(c.per)} · ${estLabel(c.it.estado)}`;
    function exportarAprobadas(rs, nombre){
      const fila = r => { const c = (r.cands||[]).find(x=>x.id===r.elegido); return Object.assign({}, r, {c}); };
      LS.comp.exportar({archivo:'Facturas emitidas - control '+ui.hoy()+'.xlsx', hoja:'Control', filas:rs.map(fila), cols:[
        {l:'Resultado', w:26, v:r=>RES[r.res][0]}, {l:'Detalle', w:48, v:r=>r.det||''}, {l:'Factura', w:20, v:r=>r.nro}, {l:'Fecha', w:12, v:r=>fmtF(r.fecha)}, {l:'Cliente (Excel)', w:40, v:r=>r.cliente},
        {l:'Pedido', w:16, v:r=>r.pedido}, {l:'Moneda', w:8, v:r=>r.moneda}, {l:'Importe', w:16, v:r=>r.importe}, {l:'Autorizada', w:10, v:r=>r.autorizado?'Sí':'No'},
        {l:'Cliente en el sistema', w:30, v:r=>r.c ? r.c.s.cliente : ((r.servs||[]).map(s=>s.cliente).join(' / '))}, {l:'Servicio', w:40, v:r=>r.c ? r.c.s.servicio : ((r.servs||[]).map(s=>s.servicio).join(' / '))}, {l:'Período', w:14, v:r=>r.c ? mesLabel(r.c.per) : ''}],
        filtros:[['Archivo importado', nombre||''], ['Fecha de control', fmtF(ui.hoy())]]});
    }
    async function importarAprobadas(){
      if(RO()) return; if(!meses().length) return ui.toast('Primero abrí un período.');
      const f = await sys.pickFile('Elegí el Excel de facturas emitidas (APROBACION DE FC)', ['xlsx','xls']); if(!f) return;
      let rs; try{ rs = enlazarAprobadas(await leerAprobadas(f)); }catch(e){ return ui.alerta('No se pudo leer el Excel: '+esc(sys.errMsg(e))); }
      if(!rs.length) return ui.alerta('No encontré facturas en el Excel. Tiene que tener las columnas Nro. y Pedido.');
      const nombre = f.split(/[\\/]/).pop(); let soloAut = true;   // 1.0.15: por defecto solo las autorizadas (se puede destildar)
      const html = () => { const cnt = k => rs.filter(r=>r.res===k).length; const aMarcar = rs.filter(r=>r.res==='marcar' && r.elegido && (!soloAut || r.autorizado)).length;
        return `<p class="muted" style="margin-top:0"><b>${esc(nombre)}</b>: ${rs.length} comprobante(s). Se enlazan por el <b>pedido</b> con los servicios del sistema; solo cambian las líneas que todavía no se enviaron. Revisá la línea elegida en cada caso.</p>
        <div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">${Object.keys(RES).filter(k=>cnt(k)).map(k=>LS.comp.estado(RES[k][0]+': '+cnt(k), RES[k][1])).join(' ')}<span class="grow"></span>
          <label class="chk sm"><input type="checkbox" id="apSA" ${soloAut?'checked':''}> Marcar solo las autorizadas</label><button class="btn sm" id="apX">${I('excel')} Exportar a Excel</button></div>
        <div style="max-height:52vh;overflow:auto;border:1px solid var(--line);border-radius:6px"><table class="grid aprob" style="table-layout:fixed;width:100%;font-size:12.5px"><thead><tr><th style="width:125px">Factura</th><th style="width:21%">Cliente (Excel)</th><th style="width:112px">Pedido</th><th class="num" style="width:125px">Importe</th><th style="width:40px">Aut.</th><th>Línea del seguimiento</th></tr></thead><tbody>
        ${rs.map((r,i)=>`<tr><td class="nw">${esc(r.nro)}<div class="muted sm">${esc(fmtF(r.fecha))}</div></td><td>${esc(r.cliente)}</td><td class="nw">${esc(r.pedido||'—')}</td><td class="num nw">${esc(r.moneda)} ${esc(Number(r.importe).toLocaleString('es-AR',{minimumFractionDigits:2, maximumFractionDigits:2}))}</td><td>${r.autorizado?'Sí':'<span class="muted">No</span>'}</td>
          <td>${(r.res==='marcar' || r.res==='yaLista') && r.cands.length ? `<select class="inp sm" data-ap="${i}" style="width:100%">${r.cands.map(c=>`<option value="${esc(c.id)}" ${c.id===r.elegido?'selected':''}>${esc(candTxt(c))}</option>`).join('')}<option value="" ${r.elegido?'':'selected'}>— No marcar —</option></select>` : ''}
            <div class="sm" style="margin-top:2px">${LS.comp.estado(RES[r.res][0], RES[r.res][1])} ${r.det?`<span class="muted">${esc(r.det)}</span>`:''}${r.res==='marcar' && soloAut && !r.autorizado?' <span class="muted">(no autorizada: no se marca)</span>':''}</div></td></tr>`).join('')}</tbody></table></div>
        <p class="muted sm" style="margin-bottom:0">A cada línea marcada se le agrega una nota con el número de factura. Se puede deshacer con <b>Deshacer</b>.</p>
        <p style="margin-bottom:0"><b id="apN">${aMarcar}</b> línea(s) pasan a <b>Listo para enviar</b>.</p>`; };
      const elegidas = () => rs.filter(r=>r.res==='marcar' && r.elegido && (!soloAut || r.autorizado));
      const v = await ui.modal({titulo:'Facturas emitidas → Listo para enviar', lg:true, html:html(), botones:[{txt:'Cancelar', val:null},{txt:'Marcar como Listo para enviar', primary:true, val:'ok'}],
        onOpen: ov=>{ const cablear = ()=>{ ov.querySelector('#apX').onclick = ()=>exportarAprobadas(rs, nombre);
            ov.querySelector('#apSA').onchange = e=>{ soloAut = e.target.checked; ov.querySelector('.modal-b').innerHTML = html(); cablear(); };
            ov.querySelectorAll('[data-ap]').forEach(sel=> sel.onchange = ()=>{ const r = rs[+sel.dataset.ap]; const otra = rs.find((x,j)=>j!==+sel.dataset.ap && sel.value && x.elegido===sel.value);
              if(otra){ ui.toast('Esa línea ya está elegida para la factura '+otra.nro+'.'); sel.value = r.elegido; return; }
              r.elegido = sel.value; const c = r.cands.find(x=>x.id===r.elegido); r.res = c && c.it.estado==='lista para enviar' ? 'yaLista' : 'marcar';
              ov.querySelector('#apN').textContent = elegidas().length; }); };
          cablear(); }});
      if(v!=='ok') return;
      const sel = elegidas(); const problemas = rs.filter(r=>['sinPedido','sinLinea','repetida'].includes(r.res) || r.aviso);
      if(sel.length){
        const hoyN = ui.hoy().split('-').reverse().join('-');
        const ok = await guardar(d=>{ sel.forEach(r=>{ const y = buscarItem(d, r.elegido); if(!y || y.it.estado==='enviado') return;
            y.it.estado = 'lista para enviar'; y.it.fechaEnvio = ''; delete y.it.nuevo; y.it.factura = r.nro;
            const linea = `${hoyN} Factura ${r.nro} emitida el ${fmtF(r.fecha)} por ${r.moneda} ${Number(r.importe).toLocaleString('es-AR',{minimumFractionDigits:2, maximumFractionDigits:2})} (importada del Excel de facturas emitidas).`;
            y.it.notas = ((y.it.notas||'').trim() ? y.it.notas.trim()+'\n' : '') + linea; }); }, `Importó facturas emitidas: ${sel.length} línea(s) a "Listo para enviar"`);
        if(!ok) return;
      }
      repintar();
      st.revisar = problemas.length ? {rs, nombre, cant:sel.length} : null;
      if(problemas.length){ if(st.sec==='seguimiento') repintar(); await facturasParaRevisar(); }
      else ui.toast(sel.length ? sel.length+' línea(s) pasaron a "Listo para enviar".' : 'No había líneas para cambiar.');
    }
    /* 1.0.15: cliente y servicio del sistema de cada factura a revisar (para ir a editarlos con un clic) */
    async function clienteDeFactura(r, C){
      // por el servicio de Facturación enlazado por pedido (vínculo origen.f01 en la base de Clientes)
      const fids = ((r.cands||[]).find(c=>c.id===r.elegido) ? [r.cands.find(c=>c.id===r.elegido).s.id] : []).concat((r.servs||[]).map(s=>s.id));
      for(const fid of fids){ for(const c of C.clientes){ const sv = c.servicios.find(x=>x.origen && x.origen.f01===fid); if(sv) return {clienteId:c.id, servicioId:sv.id, nombre:c.nombreFantasia}; } }
      // por el nombre del cliente del Excel (razón social o nombre de fantasía)
      const STOP = ['s.a','sa','srl','sau','sca','llc','inc','and','the','de','del','la','las','los','y','en','por','para','sociedad','anonima','comandita','acciones','argentina','grupo'];
      const tk = t => ui.norm(t).replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>=3 && !STOP.includes(w));
      const x = tk(r.cliente); if(!x.length) return null;
      let best = null, bs = 0;
      C.clientes.forEach(c=>{ const y = new Set(tk((c.razonSocial||'')+' '+(c.nombreFantasia||''))); if(!y.size) return; const n = x.filter(w=>y.has(w)).length; const sc = n / Math.min(x.length, y.size); if(sc > bs || (sc===bs && best && c.servicios.length > best.servicios.length)){ bs = sc; best = c; } });
      return best && bs >= 0.6 ? {clienteId:best.id, servicioId:null, nombre:best.nombreFantasia} : null;
    }
    async function facturasParaRevisar(){
      const R = st.revisar; if(!R) return;
      const problemas = R.rs.filter(r=>['sinPedido','sinLinea','repetida'].includes(r.res) || r.aviso);
      let C = {clientes:[]}; try{ C = await LS.clientes.datos(); }catch(e){}
      const dest = []; for(const r of problemas) dest.push(await clienteDeFactura(r, C));
      const a = await ui.modal({titulo:'Facturas para revisar', lg:true, html:`${R.cant?`<p style="margin-top:0">${R.cant} línea(s) pasaron a <b>Listo para enviar</b>.</p>`:''}<p>Revisá estas facturas: no se pudieron enlazar con una línea pendiente, o el pedido cargado en el sistema no coincide del todo. Con <b>Ir al cliente</b> abrís sus servicios para corregir el pedido; esta lista queda disponible en Seguimiento.</p>
          <table class="grid"><thead><tr><th>Factura</th><th>Cliente (Excel)</th><th>Pedido</th><th>Motivo</th><th style="width:130px"></th></tr></thead><tbody>${problemas.map((r,i)=>`<tr><td class="nw">${esc(r.nro)}</td><td>${esc(r.cliente)}</td><td class="nw">${esc(r.pedido||'—')}</td><td>${r.aviso && !['sinPedido','sinLinea','repetida'].includes(r.res) ? LS.comp.estado('Revisar pedido','warn') : LS.comp.estado(RES[r.res][0], RES[r.res][1])} <span class="muted sm">${esc(r.det)}</span></td>
            <td>${dest[i] ? `<button class="btn sm" data-ir="${i}" title="${esc(dest[i].nombre+(dest[i].servicioId?' · al servicio enlazado':' · sus servicios'))}">${I('external')} Ir al cliente</button>` : '<span class="muted sm">cliente no identificado</span>'}</td></tr>`).join('')}</tbody></table>`,
          botones:[{txt:'Cerrar', val:null},{txt:'Ya lo revisé (quitar la lista)', val:'listo'},{txt:'Exportar a Excel', val:'xls', primary:true}],
          onOpen:(ov, close)=> ov.querySelectorAll('[data-ir]').forEach(b=> b.onclick = ()=>{ const d = dest[+b.dataset.ir]; close(null);
            setTimeout(()=> ctx.irA && ctx.irA('clientes', {clienteId:d.clienteId, servicioId:d.servicioId, tab:'servicios'}), 50); })});
      if(a==='xls') exportarAprobadas(R.rs, R.nombre);
      if(a==='listo'){ st.revisar = null; if(st.sec==='seguimiento') repintar(); }
    }

    /* ================= MONTAJE ================= */
    function render(){
      if(!D) return;
      const v = {estado:vEstado, seguimiento:vSeguimiento, cierre:vCierre, servicios:vServicios, papelera:vPapelera}[st.sec] || vEstado;
      v();
    }
    let listo = false;
    (async ()=>{ root.innerHTML = '<div class="scroll"><div class="empty">Cargando…</div></div>'; listo = await cargar(); if(listo){ render(); ctx.refrescarMenu(); } })();

    return {
      seccion(s, arg){ st.sec = s || 'estado'; if(arg && arg.filtros) st.seg = Object.assign({mostrar:'actual_ant'}, arg.filtros); if(listo) render(); },
      acciones(){
        const g = [
          {grupo:'Período', items:[{txt:'Abrir período', icono:'plus', nivel:'editar', run:abrirPeriodo}]},
          {grupo:'Seguimiento', items:[{txt:'Agregar línea', icono:'plus', nivel:'editar', run:()=>{ if(!st.mes) return ui.toast('Primero abrí un período.'); agregarLinea(); }}, {txt:'Nuevo servicio', icono:'briefcase', nivel:'editar', run:()=>formServicio(null)}, {txt:'Importar facturas emitidas', icono:'upload', nivel:'editar', run:importarAprobadas}]},
          {grupo:'Exportar', items:[{txt: st.sec==='servicios' ? 'Excel servicios' : st.sec==='cierre' ? 'Excel cierre' : 'Excel seguimiento', icono:'excel', run:()=> st.sec==='servicios' ? exportarServicios() : st.sec==='cierre' ? exportarCierre() : exportarSeguimiento()}]},
          {grupo:'Herramientas', items:[{txt:'Limpiar líneas en blanco', icono:'trash', nivel:'editar', run:limpiarEnBlanco}, {txt:'Diferencias con Clientes', icono:'alert', run:()=>LS.facturacion.discrepancias()}]}];
        return D ? g : [];
      },
      mtime: () => doc.mtime,
      async externo(){ await cargar(); render(); },
      sucio: () => false,
      activado(){}
    };



  } };
})();
