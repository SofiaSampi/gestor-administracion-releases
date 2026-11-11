/* Módulo CLIENTES — base única de clientes del programa.
   Cliente → Servicios (N) → datos de facturación, contrato e incremento por servicio.
   El resto de los módulos toman el cliente de acá (LS.clientes). */
(function(){
  const {sys, path, ui, db, auth} = LS;
  const {esc, $, $$} = ui;
  const I = LS.icon;
  const ARCHIVO = () => db.p.datos('clientes', 'clientes.json');

  const CONFIG_DEF = () => ({
    empresasFacturantes:['LINKSOLUTION SRL','LINKSOLUTION LLC','GRUPO LS','TECTUARY'],
    paises:['Argentina','Chile','USA','Uruguay','Otro'],
    sectores:['CONTACT CENTER','SOPORTE IT','VENTAS','DESARROLLO','AUDITORÍA','CONSULTORÍA RRHH','OTROS'],
    estados:['Cliente nuevo','Activo','Activo sin facturación','Contrato vencido','Finalizado','Inactivo'],
    estadosActivos:['Cliente nuevo','Activo','Activo sin facturación','Contrato vencido'],
    condicionesPago:['Contado','15 días','30 días','30/60 días','60 días','90 días','Cuenta corriente 30'],
    tiposAcuerdo:['CONTRATO','PROPUESTA','ADENDA','PRÓRROGA','SIN CONTRATO','NP','CARTA DE OFERTA'],
    renovacion:['Renovación automática','Renovación manual'],
    vigencias:['indeterminada','fija'],
    tiposIncremento:['CCT 100%','CCT 85% IPC 15%','IPC 100%','UF','No aplica'],
    requiereAceptacion:['Sí','No','No aplica'],
    acuerdosCCT:['CCT JUL-26','CCT ABR-26'],
    gerentes:[], responsablesFacturacion:[],
    tiposFacturacion:['MENSUAL','EVENTUAL'], grupos:['A','B','C'], modalidades:['vencido','encurso'],
    checklistAlta:[{key:'cuit',label:'CUIT'},{key:'servicio',label:'Servicio'},{key:'contrato',label:'Contrato'},{key:'vigencia',label:'Vigencia del contrato'},{key:'mesInicio',label:'Mes de inicio de servicio'}]
  });
  const DEF = () => ({version:1, savedAt:null, config:CONFIG_DEF(), clientes:[]});
  const LISTAS = [
    ['empresasFacturantes','Empresas facturantes'],['paises','Países'],['sectores','Sectores'],['estados','Estados de servicio'],
    ['estadosActivos','Estados que cuentan como "activo"'],['gerentes','Gerentes a cargo'],['responsablesFacturacion','Responsables de facturación'],
    ['condicionesPago','Condiciones de pago'],['tiposAcuerdo','Tipos de acuerdo'],['renovacion','Renovación'],['tiposIncremento','Tipos de incremento'],
    ['requiereAceptacion','Requiere aceptación'],['acuerdosCCT','Acuerdos CCT'],['modalidades','Modalidad (vencido / en curso)']
  ];

  /* ---------- Campos de las fichas ---------- */
  const F_CLIENTE = [
    {k:'nombreFantasia', l:'Nombre de fantasía', req:true},
    {k:'razonSocial', l:'Razón social'},
    {k:'cuit', l:'CUIT / RUT / Tax ID'},
    {k:'pais', l:'País', list:'paises'},
    {k:'inicioRelacionComercial', l:'Inicio de la relación comercial', t:'date'}
  ];   // 1.0.10: Domicilio fiscal y Observaciones dejan de mostrarse (el dato viejo queda guardado)
  const F_SERV = {
    'General':[
      {k:'detalleServicio', l:'Detalle del servicio', req:true, full:true},
      {k:'empresaFacturante', l:'Empresa facturante', list:'empresasFacturantes'},
      {k:'sector', l:'Sector', list:'sectores'},
      {k:'estado', l:'Estado', list:'estados'},
      {k:'gerenteACargo', l:'Gerente a cargo', list:'gerentes'},
      {k:'fechaAlta', l:'Fecha de alta', t:'date'},
      {k:'fechaBaja', l:'Fecha de baja', t:'date'},
      {k:'observaciones', l:'Observaciones', t:'textarea', full:true}
    ],
    'Facturación':[
      {k:'responsableFacturacion', l:'Responsable (envío de mail)', list:'responsablesFacturacion'},
      {k:'modalidad', l:'Modalidad', list:'modalidades'},
      {k:'recurrente', l:'Se factura todos los meses', t:'check'},
      {k:'porPortal', l:'Se carga por portal', t:'check'},
      {k:'agrupado', l:'Facturación agrupada (varios pedidos en una factura, ej. Ford)', t:'check'},
      {k:'requiereOC', l:'Requiere OC (si falta, figura como dato faltante)', t:'check'},
      {k:'ordenCompra', l:'Orden de compra'},
      {k:'pedido', l:'Pedido / NP'},
      {k:'contactosPara', l:'Mail: Para', full:true},
      {k:'contactosCC', l:'Mail: CC', full:true},
      {k:'proceso', l:'Proceso de facturación', t:'textarea', full:true},
      {k:'observacionesFacturacion', l:'Observaciones de facturación', t:'textarea', full:true}
    ],
    'Contrato':[
      {k:'condicionPago', l:'Condición de pago', list:'condicionesPago'},
      {k:'tipoAcuerdoOriginal', l:'Tipo de acuerdo original', list:'tiposAcuerdo'},
      {k:'tipoAcuerdoVigente', l:'Tipo de acuerdo vigente', list:'tiposAcuerdo'},
      {k:'renovacion', l:'Renovación', list:'renovacion'},
      {k:'vigencia', l:'Vigencia', list:'vigencias'},
      {k:'fechaInicioUltimoContrato', l:'Inicio del último contrato', t:'date'},
      {k:'fechaFinUltimoContrato', l:'Fin del último contrato', t:'date'}
    ],
    'Incremento':[
      {k:'tipoIncremento', l:'Modalidad de incremento', list:'tiposIncremento'},
      {k:'requiereAceptacion', l:'Requiere aceptación del cliente', list:'requiereAceptacion'},
      {k:'frecuenciaIncrementoMeses', l:'Frecuencia (meses)', t:'number'},
      {k:'esquemaIncremento', l:'Esquema (ej. Trimestral)'},
      {k:'fechaUltimoIncremento', l:'Fecha del último incremento', t:'date'},
      {k:'ultimoIncrementoAceptado', l:'Último incremento aceptado', list:'acuerdosCCT', libre:true},
      {k:'proximoIncrementoManual', l:'Próximo incremento (manual, opcional)', t:'date'}
    ]
  };
  const servicioVacio = (cfg) => ({id:ui.uid('s_'), detalleServicio:'', sector:'', empresaFacturante:(cfg.empresasFacturantes||[])[0]||'', estado:'Cliente nuevo', gerenteACargo:'',
    fechaAlta:ui.hoy(), fechaBaja:'', observaciones:'', responsableFacturacion:'', modalidad:'vencido', recurrente:true, porPortal:false, requiereOC:false,
    ordenCompra:'', pedido:'', contactosPara:'', contactosCC:'', proceso:'', observacionesFacturacion:'', condicionPago:'', tipoAcuerdoOriginal:'', tipoAcuerdoVigente:'',
    renovacion:'', vigencia:'indeterminada', fechaInicioUltimoContrato:'', fechaFinUltimoContrato:'', tipoIncremento:'', requiereAceptacion:'', frecuenciaIncrementoMeses:'',
    esquemaIncremento:'', fechaUltimoIncremento:'', ultimoIncrementoAceptado:'', proximoIncrementoManual:'', origen:{}});
  /* 1.0.4: "Requiere OC" reemplaza al grupo B (los datos de Tipo y Grupo quedan guardados pero no se muestran) */
  /* 1.0.10: el checklist de alta ya no lleva "Importe" */
  function normalizarCfg(d){ d.config.checklistAlta = (d.config.checklistAlta||[]).filter(f=>f.key!=='importe'); }
  /* Duración entre dos fechas en texto (ej. 01/11/2024 a 31/10/2026 = "2 años") */
  function duracionTxt(a, b){
    if(!a || !b || b < a) return '';
    const [y1,m1,d1] = a.split('-').map(Number); const e = new Date(b+'T00:00:00'); e.setDate(e.getDate()+1);
    let m = (e.getFullYear()-y1)*12 + (e.getMonth()+1-m1); if(e.getDate() < d1) m--; if(m <= 0) return '';
    const an = Math.floor(m/12), r = m%12;
    return an && r ? `${an} año${an>1?'s':''} y ${r} mes${r>1?'es':''}` : an ? `${an} año${an>1?'s':''}` : `${r} mes${r>1?'es':''}`;
  }
  const MESES_L = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const mesTxt = f => f ? MESES_L[Number(f.slice(5,7))-1]+' '+f.slice(0,4) : '';
  function normalizarServ(d){ (d.clientes||[]).forEach(c=> (c.servicios||[]).forEach(s=>{ if(s.requiereOC===undefined) s.requiereOC = s.grupo==='B'; })); }
  const clienteVacio = () => ({id:ui.uid('c_'), nombreFantasia:'', razonSocial:'', cuit:'', pais:'Argentina', inicioRelacionComercial:'', domicilio:'', observaciones:'', contactos:[], alta:null, servicios:[], origen:{}, creado:ui.ahoraISO()});

  /* ---------- Cálculos ---------- */
  function proximoIncremento(s){
    if(s.proximoIncrementoManual) return s.proximoIncrementoManual;
    if(s.fechaUltimoIncremento && Number(s.frecuenciaIncrementoMeses)>0){
      const d = new Date(s.fechaUltimoIncremento+'T00:00:00'); d.setMonth(d.getMonth()+Number(s.frecuenciaIncrementoMeses));
      return d.toISOString().slice(0,10);
    }
    return '';
  }
  /* Fin de contrato efectivo: si la renovación es automática y ya pasó la fecha, se corre por períodos
     (duración del contrato o 12 meses) hasta la próxima renovación. */
  function finEfectivo(s){
    const fin = s.fechaFinUltimoContrato; if(!fin) return {fecha:'', renueva:false};
    if(s.renovacion!=='Renovación automática' || fin >= ui.hoy()) return {fecha:fin, renueva:false};
    let meses = 12;
    if(s.fechaInicioUltimoContrato){ const a = new Date(s.fechaInicioUltimoContrato+'T00:00:00'), z = new Date(fin+'T00:00:00'); const m = Math.round((z-a)/(30.44*86400000)); if(m>=1) meses = m; }
    const d = new Date(fin+'T00:00:00'); let guard = 0;
    while(d.toISOString().slice(0,10) < ui.hoy() && guard++ < 600) d.setMonth(d.getMonth()+meses);
    return {fecha:d.toISOString().slice(0,10), renueva:true};
  }
  const diasHasta = f => f ? Math.round((new Date(f+'T00:00:00') - new Date(ui.hoy()+'T00:00:00'))/86400000) : null;
  const esActivo = (s, cfg) => (cfg.estadosActivos||CONFIG_DEF().estadosActivos).includes(s.estado);
  const clienteActivo = (c, cfg) => c.servicios.some(s=>esActivo(s,cfg)) || (!c.servicios.length && !!c.alta);
  /* CUIT y Servicio se dan por cumplidos según los datos cargados */
  function altaOk(c, k){ if(k==='cuit') return !!String(c.cuit||'').trim(); if(k==='servicio') return (c.servicios||[]).some(s=>!s._nuevo); const a = c.alta||{}; return !!(a[k] && a[k].checked); }
  function progresoAlta(c, cfg){
    if(!c.alta) return null;
    const ck = cfg.checklistAlta||[]; const done = ck.filter(f=>altaOk(c, f.key)).length;
    return {done, total:ck.length};
  }
  function badgeDias(d, avisar=30){
    if(d==null) return '';
    if(d<0) return `<span class="badge danger">vencido hace ${-d} d</span>`;
    if(d<=avisar) return `<span class="badge warn">en ${d} d</span>`;
    return `<span class="badge">en ${d} d</span>`;
  }

  /* ================= UNIFICACIÓN CON FACTURACIÓN (1.0.10) =================
     La base de Clientes es la fuente de los datos del servicio. Al guardar un servicio acá se actualiza su par en
     datos/facturacion/data.json (vinculado por origen.f01); si es facturable y no tenía par, se crea y entra al último período. */
  const F_ARCH = () => db.p.datos('facturacion','data.json');
  const addMesF = (k, n) => { let [y,m] = k.split('-').map(Number); m += n; while(m>12){ m-=12; y++; } while(m<1){ m+=12; y--; } return y+'-'+String(m).padStart(2,'0'); };
  const factDeF = (f, bucket) => f.modalidad==='encurso' ? addMesF(bucket, 1) : bucket;
  const facturable = (s, cfg) => esActivo(s, cfg) && s.estado!=='Activo sin facturación';
  function datosFact(c, s, cfg, f){
    return {empresa:s.empresaFacturante||f.empresa||'', responsable:s.responsableFacturacion||'', modalidad:s.modalidad||'vencido', porPortal:!!s.porPortal, requiereOC:!!s.requiereOC,
      ordenCompra:s.ordenCompra||'', pedido:s.pedido||'', contactosPara:s.contactosPara||'', contactosCC:s.contactosCC||'', proceso:s.proceso||'', observaciones:s.observacionesFacturacion||'',
      recurrente:s.recurrente!==false, agrupado:!!s.agrupado, modalidadIncremento:s.tipoIncremento||'', esquemaIncremento:s.esquemaIncremento||'',
      fechaInicio:s.fechaAlta||f.fechaInicio||'', fechaBaja:s.fechaBaja||'', vigencia:s.vigencia==='fija'?'fija':'indeterminada', vigenciaFin:s.vigencia==='fija'?(s.fechaFinUltimoContrato||''):'',
      cuit: ui.soloDigitos(f.cuit||'')===ui.soloDigitos(c.cuit||'') && f.cuit ? f.cuit : (c.cuit||''), activo:facturable(s, cfg)};
  }
  /* Devuelve {nuevoId, msg} o null si Facturación todavía no tiene datos */
  async function sincronizarFacturacion(c, s, cfg, baja){
    if(!(await sys.exists(F_ARCH()))) return null;
    const docF = new LS.Doc(F_ARCH()); let previo = null, out = {nuevoId:null, msg:''};
    await docF.update(d=>{ previo = JSON.stringify(d); d.servicios = d.servicios||[]; d.meses = d.meses||{};
      const fid = s.origen && s.origen.f01; let f = fid!=null ? d.servicios.find(x=>x.id===fid) : null;
      if(baja){ if(f){ f.activo = false; if(!f.fechaBaja) f.fechaBaja = ui.hoy(); out.msg = 'Se dio de baja también en Facturación.'; } return; }
      if(!f){
        if(!facturable(s, cfg)) return;
        const id = Math.max(0, ...d.servicios.map(x=>Number(x.id)||0)) + 1;
        f = {id, cliente:c.nombreFantasia, servicio:s.detalleServicio, tipo:s.recurrente!==false?'MENSUAL':'EVENTUAL', grupo:''}; d.servicios.push(f); out.nuevoId = id;
        Object.assign(f, datosFact(c, s, cfg, f));
        const mes = Object.keys(d.meses).sort().pop();
        if(mes && f.activo && (!f.fechaInicio || factDeF(f, mes) >= f.fechaInicio.slice(0,7))){ d.meses[mes].items = d.meses[mes].items||[];
          d.meses[mes].items.push({id:ui.uid('l'), servicioId:id, estado:'', nuevo:true, facturacionMes:factDeF(f, mes), fechaEnvio:'', notas:''}); out.msg = 'Se agregó también al seguimiento de Facturación.'; }
        else out.msg = 'Quedó cargado en Facturación: entra al seguimiento cuando corresponda su período.';
        return; }
      Object.assign(f, datosFact(c, s, cfg, f));
    });
    if(previo) LS.shell.pushUndo('facturacion', {archivo:'data.json', text:previo, desc:'Servicio sincronizado: '+c.nombreFantasia});
    return out;
  }
  /* CUIT del cliente en sus servicios de Facturación */
  async function sincronizarCuit(c){
    if(!(await sys.exists(F_ARCH()))) return;
    const ids = c.servicios.map(s=>s.origen && s.origen.f01).filter(x=>x!=null); if(!ids.length) return;
    const docF = new LS.Doc(F_ARCH());
    await docF.update(d=>{ (d.servicios||[]).forEach(f=>{ if(ids.includes(f.id) && ui.soloDigitos(f.cuit||'')!==ui.soloDigitos(c.cuit||'')) f.cuit = c.cuit||''; }); });
  }
  /* Una sola vez: trae a la base los datos de facturación que se venían editando en Facturación (los vinculados) */
  function traerDeFacturacion(d, F){
    const fs = new Map((F.servicios||[]).map(f=>[f.id, f])); let n = 0;
    const M = [['responsable','responsableFacturacion'],['modalidad','modalidad'],['ordenCompra','ordenCompra'],['pedido','pedido'],['contactosPara','contactosPara'],['contactosCC','contactosCC'],['proceso','proceso'],['observaciones','observacionesFacturacion']];
    d.clientes.forEach(c=> c.servicios.forEach(s=>{ const f = s.origen && s.origen.f01!=null && fs.get(s.origen.f01); if(!f) return; let cambio = false;
      M.forEach(([a,b])=>{ if(f[a] && f[a]!==s[b]){ s[b] = f[a]; cambio = true; } });
      ['porPortal','requiereOC','recurrente','agrupado'].forEach(k=>{ if(f[k]!==undefined && !!f[k]!==!!s[k]){ s[k] = !!f[k]; cambio = true; } });
      if(f.fechaBaja && !s.fechaBaja){ s.fechaBaja = f.fechaBaja; cambio = true; }
      if(cambio) n++; }));
    return n;
  }

  /* ================= SERVICIO COMPARTIDO (lectura para otros módulos) ================= */
  let cache = null, cacheMtime = -1, cacheCheck = 0;
  const clientes = {
    cache: [],
    async datos(){
      if(Date.now()-cacheCheck > 3000 || !cache){
        cacheCheck = Date.now();
        const st = await sys.stat(ARCHIVO());
        if(!st.exists){ cache = DEF(); cacheMtime = 0; }
        else if(st.mtime !== cacheMtime){ cache = (await sys.readJSON(ARCHIVO())).data; cacheMtime = st.mtime; }
        cache.config = Object.assign(CONFIG_DEF(), cache.config||{});
        clientes.cache = cache.clientes.map(c=>resumen(c, cache.config)).sort((a,b)=>a.nombre.localeCompare(b.nombre,'es'));
      }
      return cache;
    },
    async lista({soloActivos}={}){ await clientes.datos(); return soloActivos ? clientes.cache.filter(c=>c.activo) : clientes.cache; },
    async get(id){ const d = await clientes.datos(); return d.clientes.find(c=>c.id===id) || null; },
    invalidar(){ cacheCheck = 0; },
    async alertas(){
      const d = await clientes.datos(); const out = [];
      d.clientes.forEach(c=> c.servicios.filter(s=>esActivo(s,d.config)).forEach(s=>{
        const p = proximoIncremento(s); const dp = diasHasta(p);
        if(dp!=null && dp<=15) out.push({tipo:'Incremento', icono:'trend', txt:`${c.nombreFantasia} · ${s.detalleServicio}: ${dp<0?'incremento vencido desde':'próximo incremento el'} ${ui.fecha(p)}`, mod:'clientes', sec:'contratos', notificar:true});
        const fe = finEfectivo(s); const df = diasHasta(fe.fecha);
        if(df!=null && df<=30 && !fe.renueva && s.renovacion!=='Renovación automática') out.push({tipo:'Contrato', icono:'calendar', txt:`${c.nombreFantasia} · ${s.detalleServicio}: el contrato ${df<0?'venció el':'vence el'} ${ui.fecha(s.fechaFinUltimoContrato)}`, mod:'clientes', sec:'contratos'});
      }));
      return out;
    },
    CONFIG_DEF, DEF, proximoIncremento, finEfectivo, servicioVacio, clienteVacio, esActivo
  };
  function resumen(c, cfg){ return {id:c.id, nombre:c.nombreFantasia||c.razonSocial||'(sin nombre)', razonSocial:c.razonSocial||'', cuit:c.cuit||'', pais:c.pais||'', activo:clienteActivo(c,cfg), servicios:c.servicios.length}; }
  LS.clientes = clientes;

  /* ================= INTERFAZ DEL MÓDULO ================= */
  LS.nativos.clientes = { montar(root, ctx){
    const doc = new LS.Doc(ARCHIVO(), DEF);
    const st = { sec:'clientes', selC:null, selS:null, fichaTab:'datos', servTab:'General', gC:{filtros:{}, orden:null}, gS:{filtros:{}, orden:null}, sucio:false, contratosDias:60, verInactivos:false, servVerInact:false, servOrden:null };
    let D = null;   // datos cargados

    async function cargar(){
      try{ await doc.load(); D = doc.data; D.config = Object.assign(CONFIG_DEF(), D.config||{}); D.clientes = D.clientes||[]; normalizarServ(D); normalizarCfg(D); }
      catch(e){ root.innerHTML = `<div class="scroll"><div class="banner danger">${I('alert')} No se pudo leer clientes.json: ${esc(sys.errMsg(e))}</div></div>`; return false; }
      return true;
    }
    const RO = () => ctx.readonly;
    const cfg = () => D.config;
    const cli = id => D.clientes.find(c=>c.id===id);

    /* Graba un cambio puntual sobre los datos más recientes del archivo */
    async function guardar(fn, msg){
      if(RO()) { ui.toast('Modo consulta: no se puede guardar.'); return false; }
      try{
        let previo = null;
        await doc.update(d=>{ previo = JSON.stringify(d, null, 2); d.config = Object.assign(CONFIG_DEF(), d.config||{}); d.clientes = d.clientes||[]; normalizarServ(d); normalizarCfg(d); fn(d); d.savedAt = ui.ahoraISO(); d.savedBy = auth.user.usuario; });
        D = doc.data; D.config = Object.assign(CONFIG_DEF(), D.config); normalizarCfg(D);
        if(previo) LS.shell.pushUndo('clientes', {archivo:'clientes.json', text:previo, desc: msg || 'Cambio en Clientes'});
        st.sucio = false; clientes.invalidar(); setTimeout(()=>LS.alertas.refrescar(), 300);
        ctx.estado('Guardado '+new Date().toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'}));
        if(msg){ ui.toast(msg); LS.log('clientes', msg); }
        return true;
      }catch(e){ ui.alerta(esc(sys.errMsg(e)), 'No se pudo guardar'); return false; }
    }

    /* ---------- helpers de formularios ---------- */
    function campo(f, val, pref){
      const id = pref+f.k, dis = RO()?'disabled':'';
      if(f.t==='check') return `<div class="field"><label>&nbsp;</label><label class="chk"><input type="checkbox" id="${id}" ${val?'checked':''} ${dis}> ${esc(f.l)}</label></div>`;
      let input;
      if(f.list){
        const opts = (cfg()[f.list]||[]).slice(); if(val && !opts.includes(val)) opts.push(val);
        if(f.libre) input = `<input class="inp" id="${id}" list="dl-${id}" value="${esc(val)}" ${dis}><datalist id="dl-${id}">${opts.map(o=>`<option value="${esc(o)}">`).join('')}</datalist>`;
        else input = `<select class="inp" id="${id}" ${dis}><option value=""></option>${opts.map(o=>`<option ${o===val?'selected':''}>${esc(o)}</option>`).join('')}</select>`;
      } else if(f.t==='textarea') input = `<textarea class="inp" id="${id}" ${dis}>${esc(val)}</textarea>`;
      else input = `<input class="inp" id="${id}" type="${f.t||'text'}" value="${esc(val)}" ${dis}>`;
      return `<div class="field" ${f.full?'style="grid-column:1/-1"':''}><label>${esc(f.l)}${f.req?' *':''}</label>${input}</div>`;
    }
    function leer(fields, pref, obj){
      fields.forEach(f=>{ const el = root.querySelector('#'+pref+f.k); if(!el) return; obj[f.k] = f.t==='check' ? el.checked : (f.t==='number' ? (el.value===''?'':Number(el.value)) : el.value.trim()); });
      return obj;
    }
    function marcarSucio(scope){ scope.querySelectorAll('input,select,textarea').forEach(el=> el.addEventListener('input', ()=>{ st.sucio = true; })); }
    /* Cambios sin guardar: Guardar cambios / Descartar / Seguir editando. Devuelve true si se puede continuar. */
    async function siSucio(){
      if(!st.sucio) return true;
      const r = await ui.modal({titulo:'Cambios sin guardar', html:'Hiciste cambios que todavía no guardaste. ¿Qué querés hacer?', cerrable:false,
        botones:[{txt:'Seguir editando', val:'seguir'},{txt:'Descartar', val:'descartar', danger:true},{txt:'Guardar cambios', val:'guardar', primary:true}]});
      if(r==='guardar'){
        const b = ['#gS','#gC','#gK','#gA','#gT'].map(x=>root.querySelector(x)).find(Boolean);
        if(b && b.onclick) await b.onclick();
        return !st.sucio;
      }
      if(r==='descartar'){ st.sucio = false; descartarNuevos(); return true; }
      return false;
    }
    /* Al descartar, un cliente o servicio nuevo que nunca se guardó se quita de la lista */
    function descartarNuevos(){
      D.clientes = D.clientes.filter(c=>!c._nuevo);
      D.clientes.forEach(c=>{ c.servicios = c.servicios.filter(x=>!x._nuevo); });
    }
    /* Cruz de cierre rápido del panel de un servicio */
    async function cerrarServicio(){
      if(!(await siSucio())) return;
      const c = cli(st.selC); if(c) c.servicios = c.servicios.filter(x=>!x._nuevo);
      st.selS = null; ficha();
    }

    /* ---------- grilla con filtros por columna (estilo OneSoft): ver grid.js ---------- */
    function grilla({id, cols, filas, estado, selId, vacio}){ return LS.grid.render({id, cols, filas, estado, selId, vacio}); }
    function cablearGrilla(scope, cols, filas, estado, repintar, onSel, id){ LS.grid.cablear(scope, {id, cols, filas, estado, repintar, onSel}); }
    /* Conserva la posición de scroll de las listas al volver a dibujar (elementos con data-keep) */
    function guardarScroll(){ const m = {}; root.querySelectorAll('[data-keep]').forEach(el=> m[el.dataset.keep] = [el.scrollTop, el.scrollLeft]); return m; }
    function restaurarScroll(m){ root.querySelectorAll('[data-keep]').forEach(el=>{ const v = m[el.dataset.keep]; if(v){ el.scrollTop = v[0]; el.scrollLeft = v[1]; } }); }

    /* ================= SECCIÓN: CLIENTES ================= */
    function vClientes(){
      const filas = D.clientes.map(c=>{ const act = clienteActivo(c, cfg()); return Object.assign({}, c, {_act:act, _inactivo:!act, _ns:c.servicios.filter(s=>esActivo(s,cfg())).length+'/'+c.servicios.length}); })
        .filter(c=> st.verInactivos || c._act || c.id===st.selC)
        .sort((a,b)=>(a.nombreFantasia||'').localeCompare(b.nombreFantasia||'','es'));
      const cols = [
        {k:'nombreFantasia', l:'Cliente'}, {k:'razonSocial', l:'Razón social'}, {k:'cuit', l:'CUIT'}, {k:'pais', l:'País', w:'90px'},
        {k:'_ns', l:'Serv. activos', w:'95px'},
        {k:'alta', l:'Alta', w:'70px', val:c=>{ const p = progresoAlta(c,cfg()); return p ? (p.done===p.total?'Completa':'En curso') : ''; }, html:c=>{ const p = progresoAlta(c,cfg()); return p ? `<span class="badge ${p.done===p.total?'ok':'warn'}">${p.done}/${p.total}</span>` : ''; }}
      ];
      const g = grilla({id:'clientes.lista', estado:st.gC, selId:st.selC, filas, cols, vacio:'No hay clientes. Usá "Nuevo cliente" o la Carga inicial.'});
      const sc = guardarScroll();
      root.innerHTML = `<div class="scroll" data-keep="cli-outer" style="padding:12px 14px"><div class="split">
        <div><div class="toolbar"><b>${g.vis.length}</b> clientes <span class="grow"></span><label class="chk"><input type="checkbox" id="verIn" ${st.verInactivos?'checked':''}> Ver inactivos</label></div>
          <div data-keep="cli-lista" style="max-height:calc(100vh - 290px);overflow:auto;border:1px solid var(--line);border-radius:6px">${g.html}</div></div>
        <div id="ficha">${st.selC && cli(st.selC) ? '' : '<div class="box empty">Elegí un cliente de la lista o creá uno nuevo.</div>'}</div></div></div>`;
      cablearGrilla(root, cols, filas, st.gC, vClientes, async id=>{ if(id===st.selC || !(await siSucio())) return; st.selC=id; st.selS=null; vClientes(); }, 'clientes.lista');
      root.querySelector('#verIn').onchange = e=>{ st.verInactivos = e.target.checked; vClientes(); };
      if(st.selC && cli(st.selC)) ficha();
      restaurarScroll(sc);
      ctx.refrescarMenu();
    }

    function ficha(){
      const c = cli(st.selC); const box = root.querySelector('#ficha'); const sc = guardarScroll();
      const p = progresoAlta(c, cfg());
      // 1.0.10: sin pestaña Contactos; el checklist de alta va dentro de Datos
      if(!['datos','servicios'].includes(st.fichaTab)) st.fichaTab = 'datos';
      const tabsF = [['datos','Datos'+(p?` · alta ${p.done}/${p.total}`:'')],['servicios',`Servicios (${c.servicios.length})`]];
      box.innerHTML = `<div class="box" style="padding:0">
        <div style="padding:12px 16px 0"><h3 style="margin:0 0 2px">${esc(c.nombreFantasia||'(cliente nuevo)')}</h3><div class="muted">${esc(c.razonSocial||'')} ${c.cuit?'· '+esc(c.cuit):''}</div></div>
        <div class="doctabs" style="background:none;padding:8px 10px 0">${tabsF.map(([k,l])=>`<div class="dtab ${st.fichaTab===k?'on':''}" data-t="${k}">${esc(l)}</div>`).join('')}</div>
        <div style="padding:14px 16px" id="fichaBody"></div></div>`;
      box.querySelectorAll('.dtab[data-t]').forEach(t=> t.onclick = async ()=>{ if(!(await siSucio())) return; st.fichaTab = t.dataset.t; ficha(); ctx.refrescarMenu(); });
      const b = box.querySelector('#fichaBody');
      if(st.fichaTab==='datos') fichaDatos(c, b);
      else if(st.fichaTab==='servicios') fichaServicios(c, b);

      restaurarScroll(sc);
    }

    /* Checklist de alta: solo casillas. CUIT y Servicio se tildan solos según los datos cargados. */
    const AUTO_CK = {cuit: (c, cuit) => !!String(cuit==null ? c.cuit||'' : cuit).trim(), servicio: c => (c.servicios||[]).some(s=>!s._nuevo)};
    const checkDe = (c, k) => { const a = c.alta || c.altaCerrada || {}; return !!(a[k] && a[k].checked); };
    function fichaDatos(c, b){
      const ck = cfg().checklistAlta||[];
      b.innerHTML = `<div class="grid2">${F_CLIENTE.map(f=>campo(f, c[f.k], 'fc_')).join('')}</div>
        <div class="box" style="margin:4px 0 12px;padding:10px 12px"><div class="row" style="margin-bottom:6px"><b>${I('clipboard')} Alta / checklist</b>${c.alta?'<span class="chip t-warn">alta en curso</span>':''}<span class="grow"></span><span class="muted sm">CUIT y Servicio se tildan solos.</span></div>
          <div class="row" style="flex-wrap:wrap;gap:6px 18px">${ck.map(f=>{ const auto = AUTO_CK[f.key]; const on = auto ? auto(c) : checkDe(c, f.key);
            return `<label class="chk"><input type="checkbox" data-ck="${esc(f.key)}" ${on?'checked':''} ${RO()||auto?'disabled':''}> ${esc(f.label)}${auto?' <span class="muted sm">(automático)</span>':''}</label>`; }).join('')}</div>
          ${!RO() && c.alta ? `<div style="margin-top:8px"><button class="btn sm" id="fA">${I('check')} Cerrar alta (quitar de "Altas en curso")</button></div>` : ''}</div>
        ${RO()?'':`<div class="row"><button class="btn primary" id="gC">${I('save')} Guardar cliente</button><span class="grow"></span><button class="btn danger" id="bC">${I('trash')} Eliminar</button></div>`}
        <div class="muted" style="font-size:11.5px;margin-top:10px">${c.origen&&c.origen.c05?'Importado de Contratos (05). ':''}${c.origen&&c.origen.f01?'Importado de Facturación (01). ':''}ID: <span class="mono">${esc(c.id)}</span></div>`;
      marcarSucio(b);
      const inCuit = b.querySelector('#fc_cuit'), ckCuit = b.querySelector('[data-ck="cuit"]'); if(inCuit && ckCuit) inCuit.addEventListener('input', ()=>{ ckCuit.checked = AUTO_CK.cuit(c, inCuit.value); });
      if(RO()) return;
      const fA = b.querySelector('#fA');
      if(fA) fA.onclick = async ()=>{ if(!(await siSucio())) return; if(!(await ui.confirmar('¿Cerrar el alta de este cliente? El checklist se conserva.'))) return;
        await guardar(d=>{ const x = d.clientes.find(y=>y.id===c.id); x.altaCerrada = Object.assign({fecha:ui.hoy()}, x.alta); x.alta = null; }, 'Alta cerrada: '+c.nombreFantasia); vClientes(); };
      b.querySelector('#gC').onclick = ()=>guardarCliente();
      b.querySelector('#bC').onclick = ()=>eliminarCliente();
    }
    /* Lleva a Facturación los cambios de un servicio recién guardado */
    async function sincronizar(cid, sid){
      const c = cli(cid), s = c && c.servicios.find(x=>x.id===sid); if(!s) return;
      try{
        const r = await sincronizarFacturacion(c, s, cfg(), false); if(!r) return;
        if(r.nuevoId!=null) await guardar(d=>{ const y = d.clientes.find(x=>x.id===cid).servicios.find(x=>x.id===sid); y.origen = Object.assign({}, y.origen||{}, {f01:r.nuevoId}); });
        if(r.msg) ui.toast(r.msg, {ms:6000});
        ctx.recargarFacturacion && ctx.recargarFacturacion();
      }catch(e){ ui.alerta('El servicio se guardó, pero no se pudo actualizar Facturación: '+esc(sys.errMsg(e))); }
    }
    async function guardarCliente(){
      const c = cli(st.selC); if(!c) return;
      const v = leer(F_CLIENTE, 'fc_', {});
      if(!v.nombreFantasia){ ui.alerta('Completá el nombre de fantasía.'); return; }
      // Checklist de alta (se guarda en el alta en curso, o en la cerrada como referencia)
      const marcas = {}; root.querySelectorAll('#ficha [data-ck]').forEach(x=>{ marcas[x.dataset.ck] = x.checked; });
      const dup = v.cuit && D.clientes.find(x=>x.id!==c.id && ui.soloDigitos(x.cuit) && ui.soloDigitos(x.cuit)===ui.soloDigitos(v.cuit));
      if(dup && !(await ui.confirmar(`Ya existe otro cliente con ese CUIT: <b>${esc(dup.nombreFantasia)}</b>. ¿Guardar igual?`))) return;
      const nuevo = !!c._nuevo;
      await guardar(d=>{ let x = d.clientes.find(y=>y.id===c.id); if(!x){ x = Object.assign({}, c); delete x._nuevo; d.clientes.push(x); } Object.assign(x, v, {modificado:ui.ahoraISO()});
        const destino = x.alta ? 'alta' : 'altaCerrada'; const a = x[destino] = x[destino] || {}; Object.keys(marcas).forEach(k=>{ a[k] = Object.assign({}, a[k]||{}, {checked:marcas[k]}); }); }, (nuevo?'Alta de cliente: ':'Cliente actualizado: ')+v.nombreFantasia);
      if(!nuevo && (c.cuit||'')!==(v.cuit||'')){ try{ await sincronizarCuit(cli(c.id)); ctx.recargarFacturacion && ctx.recargarFacturacion(); }catch(e){} }
      vClientes();
    }
    async function eliminarCliente(){
      const c = cli(st.selC); if(!c) return;
      if(c._nuevo){ D.clientes = D.clientes.filter(x=>x.id!==c.id); st.selC=null; st.sucio=false; return vClientes(); }
      const vinc = await vinculos931(c.id);
      const ok = await ui.confirmar(`¿Eliminar <b>${esc(c.nombreFantasia)}</b> y sus ${c.servicios.length} servicios?${vinc?`<br><br><b>Atención:</b> hay ${vinc} persona(s) del F.931 vinculadas a este cliente.`:''}<br><br><span class="muted">Si el cliente dejó de trabajar con nosotros conviene poner sus servicios en estado <b>Finalizado</b> en lugar de borrarlo.</span>`, {si:'Eliminar', peligro:true});
      if(!ok) return;
      await guardar(d=>{ d.clientes = d.clientes.filter(x=>x.id!==c.id); }, 'Cliente eliminado: '+c.nombreFantasia);
      st.selC=null; vClientes();
    }
    async function vinculos931(id){ try{ const {data} = await sys.readJSON(db.p.datos('master','master.json')); return (data.recursos||[]).filter(e=>e.clienteId===id).length; }catch(e){ return 0; } }

    function nuevoCliente(){
      siSucio().then(ok=>{ if(!ok) return;
        const c = clienteVacio(); c._nuevo = true; c.alta = {}; D.clientes.push(c);
        st.sec='clientes'; st.selC=c.id; st.fichaTab='datos'; st.gC.filtros={}; ctx.setSeccion('clientes'); vClientes();
        setTimeout(()=>{ const i = root.querySelector('#fc_nombreFantasia'); i && i.focus(); }, 30);
      });
    }

    /* ---- Servicios del cliente ---- */
    /* 1.0.13: solo los vigentes (tilde "Ver inactivos"), encabezados para ordenar, "Próximo" con lo contractual
       (vencimiento / renovación del contrato) y acciones rápidas por fila: cambiar de cliente y eliminar */
    function proximosServ(s){
      const out = []; const inc = proximoIncremento(s); if(inc) out.push({f:inc, txt:'Incremento', avisar:15});
      const fe = finEfectivo(s); if(fe.fecha) out.push({f:fe.fecha, txt: fe.renueva ? 'Renueva contrato' : (fe.fecha < ui.hoy() ? 'Venció contrato' : 'Vence contrato'), avisar:60});
      return out.sort((a,b)=>a.f.localeCompare(b.f));
    }
    function fichaServicios(c, b){
      const todas = c.servicios.map(s=>Object.assign({}, s, {_inactivo:!esActivo(s,cfg()) && !s._nuevo, _prox:proximosServ(s)}));
      const ocultos = todas.filter(s=>s._inactivo).length;
      let filas = todas.filter(s=> st.servVerInact || !s._inactivo || s.id===st.selS);
      const COLS = [['detalleServicio','Servicio'],['empresaFacturante','Empresa'],['estado','Estado'],['tipoIncremento','Incremento'],['_prox','Próximo']];
      const o = st.servOrden;
      if(o){ const val = s => o.k==='_prox' ? ((s._prox[0]||{}).f || '9999') : ui.norm(s[o.k]||'');
        filas = filas.map((s,i)=>({s,i})).sort((x,y)=>{ const a = val(x.s), z = val(y.s); return (o.k!=='_prox' && (!a)!==(!z)) ? (!a?1:-1) : (o.dir*a.localeCompare(z,'es') || x.i-y.i); }).map(x=>x.s); }
      const th = ([k,l]) => `<th data-ord="${k}" style="cursor:pointer;user-select:none" title="Ordenar">${l}${o&&o.k===k?(o.dir>0?' ▲':' ▼'):''}</th>`;
      b.innerHTML = `<div class="toolbar">${RO()?'':`<button class="btn" id="nS">${I('plus')} Nuevo servicio</button>`}<span class="grow"></span>
          <label class="chk"><input type="checkbox" id="vIS" ${st.servVerInact?'checked':''}> Ver inactivos${ocultos?` (${ocultos})`:''}</label></div>
        <div data-keep="cli-servs" style="border:1px solid var(--line);border-radius:6px;${st.selS?'max-height:190px':'height:calc(100vh - 330px);min-height:160px'};overflow:auto"><table class="grid"><thead><tr>${COLS.map(th).join('')}${RO()?'':'<th style="width:1%"></th>'}</tr></thead><tbody>
        ${filas.map(s=>`<tr class="click ${s.id===st.selS?'sel':''} ${s._inactivo?'inactivo':''}" data-id="${esc(s.id)}"><td>${esc(s.detalleServicio)}</td><td>${esc(s.empresaFacturante)}</td><td>${esc(s.estado)}</td><td>${esc(s.tipoIncremento)}</td>
          <td style="font-size:12px;min-width:120px">${s._prox.map(x=>`<div>${esc(x.txt)} <b>${ui.fecha(x.f)}</b> ${badgeDias(diasHasta(x.f), x.avisar)}</div>`).join('')}</td>
          ${RO()?'':`<td style="white-space:nowrap;text-align:right;width:1%">${s._nuevo?'':`<button class="btn sm ic" data-mov="${esc(s.id)}" title="Pasar a otro cliente (si se cargó en el cliente equivocado)">${I('swap')}</button> <button class="btn sm ic danger" data-del="${esc(s.id)}" title="Eliminar el servicio (si se cargó por error)">${I('trash')}</button>`}</td>`}</tr>`).join('')
          || `<tr><td colspan="6" class="empty">${todas.length?'No hay servicios vigentes. Tildá "Ver inactivos" para ver los demás.':'Este cliente no tiene servicios.'}</td></tr>`}
        </tbody></table></div><div id="servForm" style="margin-top:12px"></div>`;
      b.querySelectorAll('tr[data-id]').forEach(tr=> tr.onclick = async e=>{ if(e.target.closest('button')) return; if(tr.dataset.id===st.selS || !(await siSucio())) return; st.selS = tr.dataset.id; ficha(); });
      b.querySelectorAll('th[data-ord]').forEach(t=> t.onclick = ()=>{ const k = t.dataset.ord; st.servOrden = !o || o.k!==k ? {k, dir:1} : o.dir>0 ? {k, dir:-1} : null; ficha(); });
      b.querySelector('#vIS').onchange = e=>{ st.servVerInact = e.target.checked; ficha(); };
      b.querySelectorAll('[data-del]').forEach(x=> x.onclick = async ()=>{ if(!(await siSucio())) return; const sv = c.servicios.find(z=>z.id===x.dataset.del); if(sv) eliminarServicio(c, sv); });
      b.querySelectorAll('[data-mov]').forEach(x=> x.onclick = async ()=>{ if(!(await siSucio())) return; const sv = c.servicios.find(z=>z.id===x.dataset.mov); if(sv) moverServicio(c, sv); });
      if(!RO()) b.querySelector('#nS').onclick = async ()=>{ if(c._nuevo){ ui.alerta('Primero guardá los datos del cliente.'); return; } if(!(await siSucio())) return; const s = servicioVacio(cfg()); s._nuevo = true; c.servicios.push(s); st.selS = s.id; st.servTab='General'; ficha(); };
      const s = c.servicios.find(x=>x.id===st.selS);
      if(s) formServicio(c, s, b.querySelector('#servForm'));
    }
    /* Guarda la carpeta de adjuntos del servicio sin tocar el resto del formulario (puede haber cambios sin guardar) */
    async function asignarCarpeta(c, s, rel){
      if(s._nuevo || c._nuevo){ ui.alerta('Primero guardá el servicio; después podés adjuntarle archivos.'); return false; }
      try{
        await doc.update(d=>{ const x = d.clientes.find(y=>y.id===c.id); const y = x && x.servicios.find(z=>z.id===s.id); if(y) y.adjuntosDir = rel; d.savedAt = ui.ahoraISO(); d.savedBy = auth.user.usuario; });
        D = doc.data; D.config = Object.assign(CONFIG_DEF(), D.config); normalizarServ(D); s.adjuntosDir = rel; clientes.invalidar();
        return true;
      }catch(e){ ui.alerta(esc(sys.errMsg(e)), 'No se pudo guardar'); return false; }
    }
    function formServicio(c, s, box){
      const tabsS = Object.keys(F_SERV).concat(['Adjuntos']);
      const prox = proximoIncremento(s);
      box.innerHTML = `<div style="border:1px solid var(--line);border-radius:8px">
        <div class="doctabs" style="padding:6px 8px 0;align-items:center">${tabsS.map(k=>`<div class="dtab ${st.servTab===k?'on':''}" data-t="${k}">${esc(k)}</div>`).join('')}
          <span class="grow"></span><span class="muted sm" style="margin-right:6px">${esc(s.detalleServicio||'Servicio nuevo')}</span><button class="modal-x" id="xS" title="Cerrar el servicio (Esc)">&times;</button></div>
        <div class="serv-ref"><span>Inicio del servicio: <b>${esc(mesTxt(s.fechaAlta||s.fechaInicioUltimoContrato)||'—')}</b></span><span>Vigencia del contrato: <b>${esc(duracionTxt(s.fechaInicioUltimoContrato, s.fechaFinUltimoContrato) || (s.vigencia==='indeterminada'?'indeterminada':'—'))}</b></span></div>
        <div style="padding:12px 14px">${tabsS.map(k=> k==='Adjuntos' ? `<div class="stab" data-t="Adjuntos" id="adjS" style="${st.servTab===k?'':'display:none'}"></div>` : `<div class="grid2 stab" data-t="${k}" style="${st.servTab===k?'':'display:none'}">${F_SERV[k].map(f=>campo(f, s[f.k], 'fs_')).join('')}
          ${k==='Incremento'?`<div class="field"><label>Próximo incremento (calculado)</label><div class="pathbox">${prox?ui.fecha(prox)+' '+badgeDias(diasHasta(prox),15):'—'}</div></div>`:''}</div>`).join('')}
        ${RO()?'':`<div class="row"><button class="btn primary" id="gS">${I('save')} Guardar servicio</button><span class="grow"></span>${s._nuevo?'':`<button class="btn" id="mS" title="Si se cargó en el cliente equivocado">${I('swap')} Cambiar de cliente</button> `}<button class="btn danger" id="bS">${I('trash')} Eliminar servicio</button></div>`}
        <div class="muted" style="font-size:11.5px;margin-top:8px">${s.origen&&s.origen.f01!=null?'Vinculado a Facturación (01) id '+esc(s.origen.f01)+'. ':''}${s.origen&&s.origen.s05?'Vinculado a Contratos (05). ':''}</div></div></div>`;
      box.querySelector('#xS').onclick = cerrarServicio;
      box.tabIndex = -1; box.onkeydown = e=>{ if(e.key==='Escape' && !document.querySelector('.ov')){ e.preventDefault(); cerrarServicio(); } };
      const pintarAdj = ()=> LS.adjuntos.panel(box.querySelector('#adjS'), {rel:s.adjuntosDir||null, relNueva:LS.adjuntos.relDe([c.razonSocial||c.nombreFantasia, s.detalleServicio||'Servicio']), ro:RO(),
        titulo:'Adjuntos del servicio (contratos, propuestas, adendas…)', vacio: s._nuevo ? 'Guardá el servicio para poder adjuntarle archivos.' : 'Todavía no hay archivos adjuntos.', asignar: rel=>asignarCarpeta(c, s, rel)});
      box.querySelectorAll('.dtab[data-t]').forEach(t=> t.onclick = ()=>{ st.servTab = t.dataset.t; box.querySelectorAll('.dtab[data-t]').forEach(x=>x.classList.toggle('on', x===t)); box.querySelectorAll('.stab').forEach(x=> x.style.display = x.dataset.t===st.servTab ? '' : 'none'); if(st.servTab==='Adjuntos') pintarAdj(); });
      if(st.servTab==='Adjuntos') pintarAdj();
      marcarSucio(box);
      if(RO()) return;
      box.querySelector('#gS').onclick = async ()=>{
        const all = [].concat(...Object.values(F_SERV)); const v = leer(all, 'fs_', {});
        if(!v.detalleServicio){ ui.alerta('Completá el detalle del servicio.'); return; }
        const nuevo = !!s._nuevo;
        const ok = await guardar(d=>{ const x = d.clientes.find(y=>y.id===c.id); let y = x.servicios.find(z=>z.id===s.id);
          if(!y){ y = Object.assign({}, s); delete y._nuevo; x.servicios.push(y); } Object.assign(y, v, {modificado:ui.ahoraISO()}); }, (nuevo?'Nuevo servicio: ':'Servicio actualizado: ')+c.nombreFantasia+' · '+v.detalleServicio);
        if(ok) await sincronizar(c.id, s.id);
        vClientes();
      };
      box.querySelector('#bS').onclick = async ()=>{
        if(s._nuevo){ c.servicios = c.servicios.filter(x=>x.id!==s.id); st.selS=null; st.sucio=false; return ficha(); }
        eliminarServicio(c, s);
      };
      const mS = box.querySelector('#mS'); if(mS) mS.onclick = async ()=>{ if(st.sucio && !(await siSucio())) return; moverServicio(c, s); };
    }
    async function eliminarServicio(c, s){
      const f01 = s.origen && s.origen.f01!=null;
      const r = await ui.modal({titulo:'Eliminar servicio', html:`¿Eliminar el servicio <b>${esc(s.detalleServicio)}</b> de <b>${esc(c.nombreFantasia)}</b>?<br><br><span class="muted">Si el servicio terminó, conviene ponerlo en estado <b>Finalizado</b> para conservar el historial. Eliminar es para lo que se cargó por error.${f01?'<br>Está vinculado a Facturación: ahí se da de baja.':''} Se puede deshacer con <b>Deshacer</b>.</span>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Eliminar', val:'si', danger:true}]});
      if(r!=='si') return;
      const ok = await guardar(d=>{ const x = d.clientes.find(y=>y.id===c.id); x.servicios = x.servicios.filter(z=>z.id!==s.id); }, 'Servicio eliminado: '+c.nombreFantasia+' · '+s.detalleServicio);
      if(ok){ try{ const r2 = await sincronizarFacturacion(c, s, cfg(), true); if(r2 && r2.msg) ui.toast(r2.msg); ctx.recargarFacturacion && ctx.recargarFacturacion(); }catch(e){ ui.alerta('El servicio se eliminó, pero no se pudo actualizar Facturación: '+esc(sys.errMsg(e))); } }
      if(st.selS===s.id) st.selS = null; st.sucio = false; vClientes();
    }
    /* 1.0.13: pasa el servicio (con todos sus datos, adjuntos y vínculo con Facturación) a otro cliente,
       sin darlo de baja. En Facturación se le corrige el cliente y el CUIT; en Incrementos, su ficha. */
    async function moverServicio(c, s){
      const otros = D.clientes.filter(x=>x.id!==c.id).sort((a,z)=>(a.nombreFantasia||'').localeCompare(z.nombreFantasia||'','es'));
      const opt = l => l.map(x=>`<option value="${esc(x.id)}">${esc(x.nombreFantasia||x.razonSocial||'(sin nombre)')}${x.razonSocial&&x.razonSocial!==x.nombreFantasia?' — '+esc(x.razonSocial):''}${x.cuit?' · '+esc(x.cuit):''}</option>`).join('');
      const dest = await ui.modal({titulo:'Cambiar de cliente', html:`<p style="margin-top:0">Pasar <b>${esc(s.detalleServicio)}</b> de <b>${esc(c.nombreFantasia)}</b> a otro cliente. Se mueve con todos sus datos; no hace falta darlo de baja.</p>
          <div class="field"><label>Buscar cliente</label><input class="inp" id="mvQ" placeholder="Nombre, razón social o CUIT"></div>
          <div class="field"><label>Cliente correcto</label><select class="inp" id="mvC" size="10" style="height:auto">${opt(otros)}</select></div>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Mover', primary:true, val:ov=>ov.querySelector('#mvC').value, validar:ov=>{ if(!ov.querySelector('#mvC').value){ ui.toast('Elegí el cliente.'); return false; } return true; }}],
        onOpen:ov=>{ const q = ov.querySelector('#mvQ'), sel = ov.querySelector('#mvC');
          q.oninput = ()=>{ const t = ui.norm(q.value), dg = ui.soloDigitos(q.value); const l = otros.filter(x=> !t || ui.norm((x.nombreFantasia||'')+' '+(x.razonSocial||'')).includes(t) || (dg.length>=3 && ui.soloDigitos(x.cuit||'').includes(dg))); sel.innerHTML = opt(l); if(l.length===1) sel.value = l[0].id; };
          sel.ondblclick = ()=> ov.querySelector('.modal-f .btn.primary').click(); }});
      if(!dest) return;
      const nc = D.clientes.find(x=>x.id===dest); if(!nc) return;
      if(!(await ui.confirmar(`Pasar <b>${esc(s.detalleServicio)}</b><br>de <b>${esc(c.nombreFantasia)}</b> a <b>${esc(nc.nombreFantasia)}</b>?`, {si:'Mover'}))) return;
      const ok = await guardar(d=>{ const a = d.clientes.find(y=>y.id===c.id), z = d.clientes.find(y=>y.id===nc.id); const i = a.servicios.findIndex(y=>y.id===s.id); if(i<0 || !z) throw new Error('No se encontró el servicio.');
        const [sv] = a.servicios.splice(i,1); sv.modificado = ui.ahoraISO(); z.servicios.push(sv); }, `Servicio pasado de cliente: ${s.detalleServicio} (${c.nombreFantasia} → ${nc.nombreFantasia})`);
      if(!ok) return;
      const avisos = [];
      // Facturación: cliente y CUIT del servicio vinculado
      const fid = s.origen && s.origen.f01;
      if(fid!=null){ try{ if(await sys.exists(F_ARCH())){ const docF = new LS.Doc(F_ARCH()); let previo = null;
            // el nombre de cliente que ya usan en Facturación los otros servicios del cliente destino (para que queden juntos)
            const ids = nc.servicios.filter(x=>x.id!==s.id).map(x=>x.origen && x.origen.f01).filter(x=>x!=null);
            await docF.update(d=>{ const f = (d.servicios||[]).find(x=>x.id===fid); if(!f) return; previo = JSON.stringify(d);
              const cuenta = {}; (d.servicios||[]).forEach(x=>{ if(ids.includes(x.id) && x.cliente) cuenta[x.cliente] = (cuenta[x.cliente]||0)+1; });
              const nombre = Object.keys(cuenta).sort((a,z)=>cuenta[z]-cuenta[a])[0];
              f.cliente = nombre || nc.nombreFantasia || nc.razonSocial || f.cliente; f.cuit = nc.cuit || ''; });
            if(previo) LS.shell.pushUndo('facturacion', {archivo:'data.json', text:previo, desc:'Servicio pasado a '+nc.nombreFantasia});
            ctx.recargarFacturacion && ctx.recargarFacturacion(); } }catch(e){ avisos.push('No se pudo actualizar Facturación: '+esc(sys.errMsg(e))); } }
      // Incrementos: la ficha del servicio sigue al servicio
      try{ const AI = db.p.datos('incrementos','incrementos.json'); if(await sys.exists(AI)){ const docI = new LS.Doc(AI); let n = 0;
          await docI.update(d=>{ (d.fichas||[]).forEach(f=>{ if(f.clienteId===c.id && f.servicioId===s.id){ f.clienteId = nc.id; n++; } }); });
          if(n && LS.shell.tabs && LS.shell.tabs.has && LS.shell.tabs.has('incrementos')) LS.shell.recargar('incrementos'); } }catch(e){ avisos.push('No se pudo actualizar la ficha de Incrementos: '+esc(sys.errMsg(e))); }
      if(avisos.length) ui.alerta(avisos.join('<br>'));
      const ir = await ui.modal({titulo:'Servicio movido', html:`<b>${esc(s.detalleServicio)}</b> ahora está en <b>${esc(nc.nombreFantasia)}</b>.${fid!=null?'<br><span class="muted">En Facturación se corrigió el cliente y el CUIT.</span>':''}`, botones:[{txt:'Quedarme acá', val:null},{txt:'Ir a '+(nc.nombreFantasia||'el cliente'), val:'ir', primary:true}]});
      if(ir==='ir'){ st.selC = nc.id; st.selS = s.id; st.fichaTab = 'servicios'; } else { st.selS = null; }
      st.sucio = false; vClientes();
    }

    /* ---- Contactos ---- */
    function fichaContactos(c, b){
      const lista = (c.contactos||[]).map(x=>Object.assign({}, x));
      const pintar = ()=>{
        b.innerHTML = `<table class="grid"><thead><tr><th>Nombre</th><th>Email</th><th>Teléfono</th><th>Rol</th><th></th></tr></thead><tbody>
          ${lista.map((x,i)=>`<tr>${['nombre','email','telefono','rol'].map(k=>`<td><input class="inp" data-i="${i}" data-k="${k}" value="${esc(x[k]||'')}" ${RO()?'disabled':''}></td>`).join('')}<td>${RO()?'':`<button class="btn sm danger" data-del="${i}">${I('x')}</button>`}</td></tr>`).join('') || '<tr><td colspan="5" class="empty">Sin contactos.</td></tr>'}
          </tbody></table>${RO()?'':`<div class="row" style="margin-top:10px"><button class="btn" id="addK">${I('plus')} Agregar contacto</button><span class="grow"></span><button class="btn primary" id="gK">${I('save')} Guardar contactos</button></div>`}`;
        b.querySelectorAll('input[data-i]').forEach(inp=> inp.oninput = ()=>{ lista[inp.dataset.i][inp.dataset.k] = inp.value; st.sucio = true; });
        b.querySelectorAll('[data-del]').forEach(x=> x.onclick = ()=>{ lista.splice(Number(x.dataset.del),1); st.sucio = true; pintar(); });
        if(RO()) return;
        b.querySelector('#addK').onclick = ()=>{ lista.push({nombre:'',email:'',telefono:'',rol:''}); pintar(); };
        b.querySelector('#gK').onclick = async ()=>{ if(c._nuevo){ ui.alerta('Primero guardá los datos del cliente.'); return; }
          await guardar(d=>{ d.clientes.find(y=>y.id===c.id).contactos = lista.filter(x=>x.nombre||x.email); }, 'Contactos actualizados: '+c.nombreFantasia); vClientes(); };
      };
      pintar();
    }

    /* ---- Alta / checklist (lo que antes estaba en el Master) ---- */
    function fichaAlta(c, b){
      const ck = cfg().checklistAlta||[]; const a = c.alta || {};
      b.innerHTML = `<p class="muted" style="margin-top:0">Datos a pedir para dar de alta el cliente o proyecto. Tildá "Confirmado" a medida que los tengas.</p>
        ${c.alta?'':`<div class="banner info" style="border-radius:6px;margin-bottom:10px">${I('clipboard')}<span class="grow">Este cliente no tiene un alta en curso.</span></div>`}
        ${ck.map(f=>`<div class="field"><label>${esc(f.label)}</label><div class="row"><input class="inp grow" style="width:auto" id="ak_${f.key}" value="${esc((a[f.key]||{}).value||'')}" ${RO()?'disabled':''}>
          <label class="chk"><input type="checkbox" id="akc_${f.key}" ${(a[f.key]||{}).checked?'checked':''} ${RO()?'disabled':''}> Confirmado</label></div></div>`).join('')}
        ${RO()?'':`<div class="row"><button class="btn primary" id="gA">${I('save')} Guardar checklist</button><span class="grow"></span>${c.alta?`<button class="btn" id="fA">${I('check')} Cerrar alta (quitar de "Altas en curso")</button>`:''}</div>`}`;
      marcarSucio(b);
      if(RO()) return;
      b.querySelector('#gA').onclick = async ()=>{ if(c._nuevo){ ui.alerta('Primero guardá los datos del cliente.'); return; }
        const alta = {}; ck.forEach(f=>{ alta[f.key] = {value: b.querySelector('#ak_'+f.key).value.trim(), checked: b.querySelector('#akc_'+f.key).checked}; });
        await guardar(d=>{ d.clientes.find(y=>y.id===c.id).alta = alta; }, 'Checklist de alta: '+c.nombreFantasia); vClientes(); };
      const fA = b.querySelector('#fA');
      if(fA) fA.onclick = async ()=>{ if(!(await ui.confirmar('¿Cerrar el alta de este cliente? El checklist se conserva en el historial.'))) return;
        await guardar(d=>{ const x = d.clientes.find(y=>y.id===c.id); x.altaCerrada = Object.assign({fecha:ui.hoy()}, x.alta); x.alta = null; }, 'Alta cerrada: '+c.nombreFantasia); vClientes(); };
    }

    /* ================= SECCIÓN: SERVICIOS (todos) ================= */
    function vServicios(){
      const filas = [];
      D.clientes.forEach(c=> c.servicios.forEach(s=>{ if(!st.verInactivos && !esActivo(s,cfg())) return; filas.push(Object.assign({}, s, {id:c.id+'|'+s.id, _cli:c.nombreFantasia, _inactivo:!esActivo(s,cfg())})); }));
      filas.sort((a,b)=>a._cli.localeCompare(b._cli,'es'));
      const cols = [
        {k:'_cli', l:'Cliente'}, {k:'detalleServicio', l:'Servicio'}, {k:'empresaFacturante', l:'Empresa'}, {k:'sector', l:'Sector'},
        {k:'estado', l:'Estado'}, {k:'gerenteACargo', l:'Gerente'}, {k:'responsableFacturacion', l:'Resp. facturación'}, {k:'tipoIncremento', l:'Incremento'},
        {k:'recurrente', l:'Mensual', w:'70px', val:s=>s.recurrente?'Sí':'No', html:s=>s.recurrente?'✓':''}
      ];
      const g = grilla({id:'clientes.servicios', estado:st.gS, filas, cols});
      const sc = guardarScroll();
      root.innerHTML = `<div class="scroll" data-keep="serv-outer" style="padding:12px 14px"><div id="sinVinc"></div><div class="toolbar"><b>${g.vis.length}</b> servicios <span class="grow"></span><label class="chk"><input type="checkbox" id="verIn" ${st.verInactivos?'checked':''}> Ver finalizados / inactivos</label></div>
        <div style="border:1px solid var(--line);border-radius:6px">${g.html}</div><p class="muted" style="font-size:12px">Doble clic en un servicio para abrir la ficha del cliente.</p></div>`;
      cablearGrilla(root, cols, filas, st.gS, vServicios, null, 'clientes.servicios');
      restaurarScroll(sc);
      root.querySelectorAll('tr[data-id]').forEach(tr=> tr.ondblclick = ()=>{ const [c,s] = tr.dataset.id.split('|'); st.selC=c; st.selS=s; st.fichaTab='servicios'; st.sec='clientes'; ctx.setSeccion('clientes'); vClientes(); });
      root.querySelector('#verIn').onchange = e=>{ st.verInactivos = e.target.checked; vServicios(); };
      // Servicios activos de Facturación que todavía no están vinculados a un servicio de la base
      (async ()=>{ try{ if(!(await sys.exists(F_ARCH()))) return; const F = (await sys.readJSON(F_ARCH())).data; const ids = new Set(); D.clientes.forEach(c=>c.servicios.forEach(x=>{ if(x.origen && x.origen.f01!=null) ids.add(x.origen.f01); }));
        const sv = (F.servicios||[]).filter(f=>f.activo && !ids.has(f.id)); const box = root.querySelector('#sinVinc'); if(!box || !sv.length) return;
        box.innerHTML = `<div class="banner warn" style="border-radius:8px;margin-bottom:10px">${I('alert')}<span class="grow"><b>${sv.length}</b> servicio(s) activos de Facturación no están vinculados a un servicio de esta lista (${esc(sv.slice(0,4).map(f=>f.cliente).join(', '))}${sv.length>4?'…':''}). Vinculalos para que se actualicen desde acá.</span><button class="btn sm" id="vincF">Revisar y vincular</button></div>`;
        box.querySelector('#vincF').onclick = ()=>LS.facturacion.discrepancias(); }catch(e){} })();
      st._ultimaGrilla = {nombre:'Servicios', vis:g.vis, cols:['_cli','detalleServicio','empresaFacturante','sector','estado','gerenteACargo','responsableFacturacion','tipoIncremento']};
    }

    /* ================= SECCIÓN: ALTAS EN CURSO ================= */
    function vAltas(){
      const l = D.clientes.filter(c=>c.alta).map(c=>({c, p:progresoAlta(c,cfg())})).sort((a,b)=>(a.p.done/a.p.total)-(b.p.done/b.p.total));
      root.innerHTML = `<div class="scroll"><h2 class="page">Altas en curso</h2><div class="page-sub">Clientes o proyectos nuevos con su checklist de datos. Al completar todo, cerrá el alta desde la ficha.</div>
        ${RO()?'':`<div class="toolbar"><button class="btn primary" id="nC">${I('plus')} Nuevo cliente / proyecto</button></div>`}
        <table class="grid"><thead><tr><th>Cliente / proyecto</th><th>Progreso</th><th>Faltan</th></tr></thead><tbody>
        ${l.map(({c,p})=>`<tr class="click" data-id="${esc(c.id)}"><td>${esc(c.nombreFantasia)}</td><td><span class="badge ${p.done===p.total?'ok':p.done===0?'danger':'warn'}">${p.done}/${p.total}</span></td>
          <td class="muted">${(cfg().checklistAlta||[]).filter(f=>!altaOk(c, f.key)).map(f=>esc(f.label)).join(', ')}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">No hay altas en curso.</td></tr>'}</tbody></table></div>`;
      root.querySelectorAll('tr[data-id]').forEach(tr=> tr.onclick = ()=>{ st.selC = tr.dataset.id; st.fichaTab='alta'; st.sec='clientes'; ctx.setSeccion('clientes'); vClientes(); });
      const n = root.querySelector('#nC'); if(n) n.onclick = nuevoCliente;
    }

    /* ================= SECCIÓN: CONTRATOS E INCREMENTOS ================= */
    function vContratos(){
      const filas = [];
      D.clientes.forEach(c=> c.servicios.filter(s=>esActivo(s,cfg())).forEach(s=>{
        const p = proximoIncremento(s);
        const fe = finEfectivo(s);
        filas.push({c, s, prox:p, dp:diasHasta(p), df:diasHasta(fe.fecha), fe});
      }));
      const N = st.contratosDias;
      const urg = filas.filter(r=>(r.dp!=null && r.dp<=N) || (r.df!=null && r.df<=N)).sort((a,b)=>Math.min(a.dp??9e9,a.df??9e9)-Math.min(b.dp??9e9,b.df??9e9));
      const sinDatos = filas.filter(r=>!r.s.tipoIncremento);
      const cols = [
        {k:'cli', l:'Cliente', txt:r=>r.c.nombreFantasia}, {k:'serv', l:'Servicio', txt:r=>r.s.detalleServicio}, {k:'emp', l:'Empresa', txt:r=>r.s.empresaFacturante},
        {k:'acu', l:'Acuerdo vigente', txt:r=>r.s.tipoAcuerdoVigente},
        {k:'fin', l:'Fin contrato', val:r=>ui.fecha(r.s.fechaFinUltimoContrato), html:r=>`${ui.fecha(r.s.fechaFinUltimoContrato)} ${r.fe.renueva ? `<span class="badge" title="Renovación automática">renueva ${ui.fecha(r.fe.fecha)}</span>` : badgeDias(r.df, N)}`},
        {k:'ren', l:'Renovación', txt:r=>r.s.renovacion}, {k:'inc', l:'Incremento', txt:r=>r.s.tipoIncremento}, {k:'frec', l:'Frec.', txt:r=>r.s.frecuenciaIncrementoMeses},
        {k:'ult', l:'Último inc.', txt:r=>ui.fecha(r.s.fechaUltimoIncremento)},
        {k:'prox', l:'Próximo inc.', val:r=>ui.fecha(r.prox), html:r=>`${ui.fecha(r.prox)} ${badgeDias(r.dp, 15)}`}
      ];
      [urg, sinDatos].forEach(l=>l.forEach(r=>{ r.id = r.c.id+'|'+r.s.id; }));
      st.gU = st.gU || {filtros:{}, orden:null}; st.gD = st.gD || {filtros:{}, orden:null};
      const g1 = grilla({cols, filas:urg, estado:st.gU, vacio:'Nada para este período.'});
      const g2 = grilla({cols, filas:sinDatos, estado:st.gD, vacio:'Todos tienen modalidad cargada.'});
      root.innerHTML = `<div class="scroll"><h2 class="page">Contratos e incrementos</h2><div class="page-sub">Servicios activos con incrementos o fin de contrato cercanos.</div>
        <div class="toolbar">Mostrar los que vencen en los próximos <select class="inp" id="dias" style="width:auto">${[15,30,60,90,180,365].map(d=>`<option ${d===N?'selected':''}>${d}</option>`).join('')}</select> días</div>
        <div class="box"><h3>${I('calendar')} Próximos vencimientos (${g1.vis.length})</h3><div style="overflow:auto" id="gU">${g1.html}</div></div>
        <div class="box"><h3>${I('alert')} Servicios activos sin modalidad de incremento (${g2.vis.length})</h3><div style="overflow:auto" id="gD">${g2.html}</div></div></div>`;
      root.querySelector('#dias').onchange = e=>{ st.contratosDias = Number(e.target.value); vContratos(); };
      const abrirFicha = id => { const [c,sv] = id.split('|'); st.selC=c; st.selS=sv; st.fichaTab='servicios'; st.servTab='Contrato'; st.sec='clientes'; ctx.setSeccion('clientes'); vClientes(); };
      cablearGrilla(root.querySelector('#gU'), cols, urg, st.gU, vContratos, abrirFicha);
      cablearGrilla(root.querySelector('#gD'), cols, sinDatos, st.gD, vContratos, abrirFicha);
      st._ultimaGrilla = {nombre:'Contratos', filasCI: filas};
    }

    /* ================= SECCIÓN: TABLAS AUXILIARES ================= */
    function vTablas(){
      root.innerHTML = `<div class="scroll"><h2 class="page">Tablas auxiliares</h2><div class="page-sub">Opciones de las listas desplegables. Una opción por línea.</div>
        <div class="cards">${LISTAS.map(([k,l])=>`<div class="box" style="margin:0"><h3>${esc(l)}</h3><textarea class="inp" data-k="${k}" style="min-height:120px" ${RO()?'disabled':''}>${esc((cfg()[k]||[]).join('\n'))}</textarea></div>`).join('')}
          <div class="box" style="margin:0"><h3>Checklist de alta</h3><textarea class="inp" id="ckAlta" style="min-height:120px" ${RO()?'disabled':''}>${esc((cfg().checklistAlta||[]).map(f=>f.label).join('\n'))}</textarea></div></div>
        ${RO()?'':`<button class="btn primary" id="gT">${I('save')} Guardar tablas</button>`}</div>`;
      marcarSucio(root);
      const g = root.querySelector('#gT'); if(!g) return;
      g.onclick = async ()=>{
        const nuevo = {}; root.querySelectorAll('textarea[data-k]').forEach(t=> nuevo[t.dataset.k] = t.value.split('\n').map(x=>x.trim()).filter(Boolean));
        const prev = cfg().checklistAlta||[];
        nuevo.checklistAlta = root.querySelector('#ckAlta').value.split('\n').map(x=>x.trim()).filter(Boolean).map(label=> prev.find(f=>f.label===label) || {key:ui.norm(label).replace(/[^a-z0-9]+/g,'_'), label});
        await guardar(d=>{ Object.assign(d.config, nuevo); }, 'Tablas auxiliares actualizadas');
        vTablas();
      };
    }

    /* ================= EXPORTAR ================= */
    async function exportar(){
      const cols = [['Cliente','c','nombreFantasia',28],['Razón social','c','razonSocial',30],['CUIT','c','cuit',15],['País','c','pais',10],
        ['Servicio','s','detalleServicio',34],['Empresa facturante','s','empresaFacturante',18],['Sector','s','sector',16],['Estado','s','estado',14],['Gerente','s','gerenteACargo',20],
        ['Resp. facturación','s','responsableFacturacion',20],['Modalidad','s','modalidad',10],['Mensual','s','recurrente',8],['Por portal','s','porPortal',9],
        ['Requiere OC','s','requiereOC',10],['OC','s','ordenCompra',14],['Pedido','s','pedido',14],['Condición de pago','s','condicionPago',14],['Acuerdo original','s','tipoAcuerdoOriginal',14],['Acuerdo vigente','s','tipoAcuerdoVigente',14],
        ['Renovación','s','renovacion',18],['Inicio contrato','s','fechaInicioUltimoContrato',12],['Fin contrato','s','fechaFinUltimoContrato',12],['Tipo incremento','s','tipoIncremento',16],
        ['Requiere aceptación','s','requiereAceptacion',10],['Frecuencia (meses)','s','frecuenciaIncrementoMeses',10],['Último incremento','s','fechaUltimoIncremento',12],['Próximo incremento','p','',12]];
      const filas = [];
      D.clientes.slice().sort((a,b)=>(a.nombreFantasia||'').localeCompare(b.nombreFantasia||'','es')).forEach(c=>{
        (c.servicios.length?c.servicios:[{}]).forEach(s=> filas.push(cols.map(([,o,k])=> o==='c'?c[k]||'' : o==='p'? (s.id?proximoIncremento(s):'') : (typeof s[k]==='boolean'?(s[k]?'Sí':'No'):(s[k]??'')))));
      });
      const blob = ui.xlsx([{nombre:'Clientes y servicios', columnas:cols.map(([t,,,w])=>({t,w})), filas}]);
      await sys.saveBlob(blob, 'Clientes y servicios '+ui.hoy()+'.xlsx');
    }

    /* ================= UNIFICAR CLIENTES ================= */
    async function unificar(){
      const c = cli(st.selC); if(!c){ ui.alerta('Elegí primero el cliente que querés unificar (el que va a desaparecer).'); return; }
      const opts = D.clientes.filter(x=>x.id!==c.id).sort((a,b)=>a.nombreFantasia.localeCompare(b.nombreFantasia,'es'));
      const dest = await ui.modal({titulo:'Unificar clientes', html:`<p>Los servicios y contactos de <b>${esc(c.nombreFantasia)}</b> pasan al cliente elegido, y <b>${esc(c.nombreFantasia)}</b> se elimina. Sirve para corregir duplicados de la carga inicial.</p>
        <div class="field"><label>Pasar todo a</label><select class="inp" id="dst">${opts.map(x=>`<option value="${esc(x.id)}">${esc(x.nombreFantasia)}${x.cuit?' · '+esc(x.cuit):''}</option>`).join('')}</select></div>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Unificar', primary:true, val:ov=>ov.querySelector('#dst').value}]});
      if(!dest) return;
      const d2 = cli(dest);
      await guardar(d=>{ const a = d.clientes.find(x=>x.id===c.id), b = d.clientes.find(x=>x.id===dest);
        b.servicios = b.servicios.concat(a.servicios); b.contactos = (b.contactos||[]).concat(a.contactos||[]);
        ['razonSocial','cuit','inicioRelacionComercial','domicilio'].forEach(k=>{ if(!b[k] && a[k]) b[k]=a[k]; });
        if(!b.alta && a.alta) b.alta = a.alta;
        b.origen = Object.assign({}, a.origen, b.origen, {unificados:(b.origen.unificados||[]).concat([a.id])});
        d.clientes = d.clientes.filter(x=>x.id!==a.id); }, `Unificó ${c.nombreFantasia} → ${d2.nombreFantasia}`);
      // Reapunta los vínculos del F.931 del Master
      try{ const f = db.p.datos('master','master.json'); const {data, mtime} = await sys.readJSON(f); let n=0;
        (data.recursos||[]).forEach(e=>{ if(e.clienteId===c.id){ e.clienteId=dest; e.proyecto=d2.nombreFantasia; n++; } });
        if(n) await sys.writeJSON(f, data, mtime); }catch(e){}
      st.selC = dest; vClientes();
    }

    /* ================= RIBBON / NAVEGACIÓN ================= */
    function render(){
      if(!D) return;
      ({clientes:vClientes, servicios:vServicios, altas:vAltas, contratos:vContratos, tablas:vTablas, carga:()=>LS.cargaInicial.vista(root, ctx, async()=>{ await cargar(); })})[st.sec]?.();
    }
    /* 1.0.10, una sola vez (editor): copia de seguridad y traer a la base los datos de facturación de los servicios vinculados */
    async function unificarUnaVez(){
      if(RO() || cfg().unificado110) return;
      try{
        await LS.backups.crear('antes-unificar-servicios').catch(()=>{});
        let n = 0; const F = (await sys.exists(F_ARCH())) ? (await sys.readJSON(F_ARCH())).data : {servicios:[]};
        await guardar(d=>{ n = traerDeFacturacion(d, F); d.config.unificado110 = ui.ahoraISO(); }, null);
        LS.log('clientes', 'Unificación de servicios con Facturación: '+n+' servicio(s) actualizados con los datos de Facturación');
        if(n) ui.toast('Servicios unificados: se trajeron los datos de facturación de '+n+' servicio(s). Hay una copia de seguridad previa en Administración → Backups.', {ms:9000});
      }catch(e){ console.warn('unificar', e); }
    }
    /* Alta de servicio desde la cinta de Facturación: se elige el cliente y se abre el servicio nuevo en su ficha */
    async function nuevoServicioElegir(){
      if(RO()) return ui.toast('Modo consulta: no se puede cargar.');
      if(!D && !(await cargar())) return;
      if(!(await siSucio())) return;
      const l = D.clientes.filter(c=>!c._nuevo).sort((a,b)=>(a.nombreFantasia||'').localeCompare(b.nombreFantasia||'','es'));
      const cid = await ui.modal({titulo:'Nuevo servicio', html:`<div class="field"><label>Cliente</label><input class="inp" id="nsQ" placeholder="Buscar cliente…" style="margin-bottom:6px"><select class="inp" id="nsC" size="10">${l.map(c=>`<option value="${esc(c.id)}">${esc(c.nombreFantasia)}${c.razonSocial?' · '+esc(c.razonSocial):''}</option>`).join('')}</select></div><div class="muted sm">¿Es un cliente nuevo? Cerrá esta ventana y usá "Nuevo cliente".</div>`,
        botones:[{txt:'Cancelar', val:null},{txt:'Continuar', primary:true, validar:ov=>{ if(!ov.querySelector('#nsC').value){ ui.toast('Elegí el cliente.'); return false; } return true; }, val:ov=>ov.querySelector('#nsC').value}],
        onOpen: ov=>{ const qq = ov.querySelector('#nsQ'), sel = ov.querySelector('#nsC'); qq.focus(); qq.oninput = ()=>{ const t = ui.norm(qq.value); Array.from(sel.options).forEach(o=> o.hidden = !!t && !ui.norm(o.textContent).includes(t)); const v = Array.from(sel.options).find(o=>!o.hidden); if(v) sel.value = v.value; }; }});
      if(!cid) return;
      const c = cli(cid); const sv = servicioVacio(cfg()); sv._nuevo = true; c.servicios.push(sv);
      st.sec = 'clientes'; st.selC = cid; st.selS = sv.id; st.fichaTab = 'servicios'; st.servTab = 'General'; ctx.setSeccion('clientes'); vClientes();
    }
    const inst = {
      nuevoServicioElegir,
      async seccion(sec, arg){
        if(sec && sec!==st.sec && !(await siSucio())) { ctx.setSeccion(st.sec); return; }
        st.sec = sec || 'clientes';
        if(arg && arg.clienteId){ st.selC = arg.clienteId; st.fichaTab = (arg.servicioId || arg.tab==='servicios') ? 'servicios' : 'datos'; st.selS = arg.servicioId || null; st.gC.filtros={};
          if(arg.servicioId){ const c0 = D && D.clientes.find(x=>x.id===arg.clienteId); const s0 = c0 && c0.servicios.find(x=>x.id===arg.servicioId); if(s0 && !esActivo(s0, cfg())) st.servVerInact = true; } }
        if(!D && !(await cargar())) return;
        await unificarUnaVez();
        render(); ctx.refrescarMenu();
      },
      acciones(){
        const ed = !RO();
        return [
          {grupo:'Clientes', items:[
            {txt:'Nuevo cliente', icono:'plus', nivel:'editar', run:nuevoCliente},
            {txt:'Unificar', icono:'merge', nivel:'editar', run:unificar, visible: st.sec==='clientes'} ]},
          {grupo:'Listados', items:[
            {txt:'Exportar a Excel', icono:'excel', run:exportar},
            {txt:'Ver inactivos', icono:'eye', on:st.verInactivos, visible:['clientes','servicios'].includes(st.sec), run:()=>{ st.verInactivos=!st.verInactivos; render(); ctx.refrescarMenu(); }} ]}
        ];
      },
      mtime: ()=>doc.mtime,
      sucio: ()=>st.sucio,
      async externo(){ await cargar(); render(); },
      cerrar(){}
    };
    return inst;
  }};
})();
