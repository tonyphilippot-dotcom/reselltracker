
// ── DATA
// 🛡️ Chargement avec fallback sur backup si principal vide
function _loadWithFallback(key){
  try{
    const main=localStorage.getItem(key);
    if(main && main!=='[]')return JSON.parse(main);
    const bak=localStorage.getItem(key+'-bak');
    if(bak && bak!=='[]'){
      console.warn('⚠️ Restauration depuis backup pour '+key);
      localStorage.setItem(key,bak);
      return JSON.parse(bak);
    }
    return [];
  }catch(e){console.error('Load error '+key+':',e);return [];}
}
let articles=_loadWithFallback('rt-art');
// ════════════════════════════════════════════════════════════════
// 🗄️ INDEXEDDB POUR LES PHOTOS (capacité illimitée vs localStorage)
// ════════════════════════════════════════════════════════════════
const IDB_NAME='reselltracker-photos';
const IDB_STORE='photos';
let _idb=null;
function _openIDB(){
  return new Promise((resolve,reject)=>{
    if(_idb)return resolve(_idb);
    const req=indexedDB.open(IDB_NAME,1);
    req.onerror=()=>reject(req.error);
    req.onsuccess=()=>{_idb=req.result;resolve(_idb);};
    req.onupgradeneeded=e=>{
      const db=e.target.result;
      if(!db.objectStoreNames.contains(IDB_STORE))db.createObjectStore(IDB_STORE);
    };
  });
}
async function idbSavePhoto(id,dataURL){
  const db=await _openIDB();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).put(dataURL,id);
    tx.oncomplete=()=>resolve(id);
    tx.onerror=()=>reject(tx.error);
  });
}
async function idbGetPhoto(id){
  if(!id||(typeof id==='string'&&id.startsWith('data:')))return id; // déjà un data URL
  const db=await _openIDB();
  return new Promise((resolve)=>{
    const tx=db.transaction(IDB_STORE,'readonly');
    const req=tx.objectStore(IDB_STORE).get(id);
    req.onsuccess=()=>resolve(req.result||null);
    req.onerror=()=>resolve(null);
  });
}
async function idbDeletePhoto(id){
  if(!id||(typeof id==='string'&&id.startsWith('data:')))return;
  const db=await _openIDB();
  return new Promise((resolve)=>{
    const tx=db.transaction(IDB_STORE,'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete=()=>resolve();
    tx.onerror=()=>resolve();
  });
}

// Cache mémoire (pour rendu synchrone des photos)
const _photoCache={};
async function preloadPhotos(){
  const db=await _openIDB();
  return new Promise((resolve)=>{
    const tx=db.transaction(IDB_STORE,'readonly');
    const store=tx.objectStore(IDB_STORE);
    const req=store.openCursor();
    req.onsuccess=e=>{
      const cur=e.target.result;
      if(cur){_photoCache[cur.key]=cur.value;cur.continue();}
      else resolve();
    };
    req.onerror=()=>resolve();
  });
}
// Récupère le data URL d'une photo (depuis cache ou base64 direct)
function getPhotoURL(idOrData){
  if(!idOrData)return '';
  if(typeof idOrData!=='string')return '';
  // URL R2 publique : retourner directement (multi-device)
  if(idOrData.startsWith('http://')||idOrData.startsWith('https://'))return idOrData;
  // Data URL : retourner directement
  if(idOrData.startsWith('data:'))return idOrData;
  // Sinon : ID local IndexedDB → cherche dans le cache
  return _photoCache[idOrData]||'';
}
// Génère un ID unique pour une photo
function _photoId(){return 'p_'+Date.now()+'_'+Math.random().toString(36).slice(2,8);}
// Stocke une photo (en data URL) dans IDB et retourne l'ID
async function storePhoto(dataURL){
  const id=_photoId();
  await idbSavePhoto(id,dataURL);
  _photoCache[id]=dataURL;
  return id;
}


let futurs=_loadWithFallback('rt-fut');
let tracking=_loadWithFallback('rt-trk');
let objectif=parseFloat(localStorage.getItem('rt-obj')||'0');
let addPhotos=[],selectedColors=[],currentId=null;
let stockFilter='tous',futurFilter='tous',ventesTab='env',histoTab='m',chartMode='m',payTab='attente',dashPeriod='month';
let chartObj=null,qrStream=null,qrInterval=null;
let calYear=new Date().getFullYear(),calMonth=new Date().getMonth();
function save(){
  try {
    localStorage.setItem('rt-art',JSON.stringify(articles));
    localStorage.setItem('rt-fut',JSON.stringify(futurs));
    localStorage.setItem('rt-trk',JSON.stringify(tracking));
    localStorage.setItem('rt-saved-at',new Date().toISOString());
    // Backups (non-bloquant)
    try{
      localStorage.setItem('rt-art-bak',localStorage.getItem('rt-art'));
      localStorage.setItem('rt-fut-bak',localStorage.getItem('rt-fut'));
      localStorage.setItem('rt-trk-bak',localStorage.getItem('rt-trk'));
    }catch(e){}
    autoBackup();
    scheduleCloudBackup();
    return true;
  } catch(e) {
    console.error('Save error:',e);
    alert('Erreur de sauvegarde : '+e.message);
    return false;
  }
}
function autoBackup(){
  try{
    const data={articles,futurs,tracking,vendeurs:JSON.parse(localStorage.getItem('rt-vendeurs')||'[]'),pays:JSON.parse(localStorage.getItem('rt-pay')||'[]'),objectif,date:new Date().toISOString()};
    localStorage.setItem('rt-autobackup',JSON.stringify(data));
    localStorage.setItem('rt-autobackup-date',new Date().toLocaleString('fr-FR'));
    // Tous les 5 articles vendus : proposer export
    const total=articles.filter(a=>a.statut==='vendu').length;
    if(total>0 && total%5===0){
      const last=localStorage.getItem('rt-last-export-count')||'0';
      if(parseInt(last)!==total){
        localStorage.setItem('rt-last-export-count',total+'');
        setTimeout(()=>{
          if(confirm('Tu as '+total+' ventes ! Veux-tu sauvegarder tes donnees maintenant ?')){
            backupData();
          }
        },1000);
      }
    }
  }catch(e){}
}


// ── ☁️ CLOUD SYNC
const CLOUD_URL = 'https://resell-proxy.tony-philippot.workers.dev';

// ════════════════════════════════════════════════════════════════
// ☁️ STOCKAGE PHOTOS R2 (Cloudflare)
// ════════════════════════════════════════════════════════════════
const R2_PUBLIC_URL = 'https://pub-c8ab60c2c612445fa8794ab359c5a23f.r2.dev';

// Upload une photo (data URL) vers R2 → retourne l'URL publique
async function uploadPhotoToR2(dataURL){
  try{
    // Extraire le blob depuis le data URL
    const resp=await fetch(dataURL);
    const blob=await resp.blob();
    const photoId='photo_'+Date.now()+'_'+Math.random().toString(36).slice(2,10)+'.jpg';
    // PUT vers le worker
    const putResp=await fetch(CLOUD_URL+'/photo/'+photoId,{
      method:'PUT',
      headers:{'Content-Type':'image/jpeg'},
      body:blob
    });
    if(!putResp.ok)throw new Error('Upload failed: '+putResp.status);
    // L'URL publique de la photo
    return R2_PUBLIC_URL+'/'+photoId;
  }catch(e){
    console.error('uploadPhotoToR2 error:',e);
    return null;
  }
}

// Supprime une photo de R2 (si l'URL pointe vers notre bucket)
async function deletePhotoFromR2(url){
  if(!url||typeof url!=='string'||!url.startsWith(R2_PUBLIC_URL))return;
  const photoId=url.replace(R2_PUBLIC_URL+'/','');
  try{await fetch(CLOUD_URL+'/photo/'+photoId,{method:'DELETE'});}
  catch(e){console.warn('Delete photo failed:',e);}
}

// Helper : vérifie si c'est une URL R2
function isR2Url(s){return typeof s==='string'&&s.startsWith(R2_PUBLIC_URL);}

// ── 🔄 Vérification cloud au démarrage (ROBUSTE)
async function checkCloudOnStart(){
  const cloudKey=localStorage.getItem('rt-cloud-key');
  if(!cloudKey) return;
  try{
    const resp=await fetch(CLOUD_URL,{method:'POST',body:JSON.stringify({_action:'restore',_key:cloudKey})});
    const r=await resp.json();
    if(!r.backup||!r.backup.date||!r.backup.data) return;
    const cloudTime=new Date(r.backup.date).getTime();
    // ✅ Utiliser rt-cloud-last (dernière sync cloud réussie) au lieu de rt-saved-at
    // Comme ça on détecte si le cloud a été modifié par un autre appareil depuis notre dernière sync
    const lastCloudSync=localStorage.getItem('rt-cloud-last')?new Date(localStorage.getItem('rt-cloud-last')).getTime():0;
    const cloudArticleCount=(r.backup.data.articles||[]).length;
    const localArticleCount=articles.length;
    
    // ✅ Restaurer SI:
    // 1) Cloud a été modifié depuis notre dernière sync (un autre appareil a modifié) OU
    // 2) Local est COMPLÈTEMENT VIDE et cloud a des données (premier démarrage / cache vidé)
    if(cloudTime > lastCloudSync + 2000 || (localArticleCount === 0 && cloudArticleCount > 0)){
      const d=r.backup.data;
      if(d.articles) articles=await _articlesFromCloud(d.articles);
      if(d.futurs) futurs=d.futurs;
      if(d.tracking) tracking=d.tracking;
      if(d.vendeurs) localStorage.setItem('rt-vendeurs',JSON.stringify(d.vendeurs));
      if(d.pays) localStorage.setItem('rt-pay',JSON.stringify(d.pays));
      if(d.objectif!==undefined){objectif=d.objectif;localStorage.setItem('rt-obj',objectif);}
      save();
      // ✅ Mettre à jour rt-cloud-last pour éviter de re-restaurer en boucle
      localStorage.setItem('rt-cloud-last',r.backup.date);
      showToast('☁️ Synchronisé ('+articles.length+' articles)');
      renderDashboard();renderStock();renderVentes();renderFuturs();
    }
  }catch(e){console.warn('checkCloudOnStart failed:',e);}
}





function getCloudKey() {
  let k = localStorage.getItem('rt-cloud-key');
  if (!k) {
    k = prompt('🔐 Crée ton identifiant cloud (mot/phrase secrète à retenir, ex: tony2024). Tu en auras besoin pour restaurer tes données sur un autre appareil.');
    if (k && k.trim().length >= 3) {
      k = k.trim().toLowerCase().replace(/[^a-z0-9_-]/g,'');
      localStorage.setItem('rt-cloud-key', k);
    } else {
      return null;
    }
  }
  return k;
}

// ── 📸 Sync photos via cloud (embed/extract data URLs)
async function _articlesForCloud(){
  // Avec R2, les photos sont des URLs publiques → on les garde tels quels.
  // Pour les anciennes photos en IDB (ancien système), on tente upload R2 maintenant.
  const result=[];
  for(const art of articles){
    const photos=[];
    for(const p of(art.photos||[])){
      if(typeof p!=='string')continue;
      if(p.startsWith('http://')||p.startsWith('https://')){
        // Déjà sur R2 → garder l'URL
        photos.push(p);
      }else if(p.startsWith('data:')){
        // Vieux data URL → upload vers R2 (one-time)
        const r2Url=await uploadPhotoToR2(p);
        photos.push(r2Url||p);
      }else{
        // ID IndexedDB → récupérer le data URL puis upload R2
        const dataURL=await idbGetPhoto(p);
        if(dataURL){
          const r2Url=await uploadPhotoToR2(dataURL);
          photos.push(r2Url||dataURL);
        }
      }
    }
    result.push({...art,photos});
  }
  return result;
}
async function _articlesFromCloud(arts){
  // Avec R2 : les URLs publiques restent telles quelles (chaque appareil les charge depuis R2)
  // Les anciens data URLs sont gardés en IDB pour compatibilité
  for(const art of(arts||[])){
    const newPhotos=[];
    for(const p of(art.photos||[])){
      if(typeof p!=='string')continue;
      if(p.startsWith('http://')||p.startsWith('https://')){
        // URL R2 publique : garder telle quelle, accessible depuis tout appareil
        newPhotos.push(p);
      }else if(p.startsWith('data:')){
        // Vieux data URL : stocker en IDB local
        const id=await storePhoto(p);
        newPhotos.push(id);
      }else newPhotos.push(p);
    }
    art.photos=newPhotos;
  }
  return arts;
}

async function cloudBackup(silent) {
  const key = getCloudKey();
  if (!key) { if(!silent) alert('Sauvegarde annulée'); return false; }
  try {
    const articlesEmbed = await _articlesForCloud();
    const data = {
      articles: articlesEmbed, futurs, tracking,
      vendeurs: JSON.parse(localStorage.getItem('rt-vendeurs')||'[]'),
      pays: JSON.parse(localStorage.getItem('rt-pay')||'[]'),
      objectif
    };
    const resp = await fetch(CLOUD_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({_action:'backup', _key:key, _data:data})
    });
    const r = await resp.json();
    if (r.saved) {
      localStorage.setItem('rt-cloud-last', new Date().toISOString());
      if (!silent) {
        showToast('✅ Paires enregistrées dans le cloud');
        renderDashboard();
      }
      return true;
    }
    if (!silent) alert('Erreur sauvegarde cloud');
    return false;
  } catch(e) {
    if (!silent) alert('Erreur cloud : '+e.message);
    return false;
  }
}

async function cloudRestore() {
  const key = prompt('🔐 Entre ton identifiant cloud pour restaurer :');
  if (!key || key.trim().length < 3) { alert('Identifiant invalide'); return; }
  const k = key.trim().toLowerCase().replace(/[^a-z0-9_-]/g,'');
  try {
    const resp = await fetch(CLOUD_URL, {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({_action:'restore', _key:k})
    });
    const r = await resp.json();
    if (!r.backup) { alert('Aucune sauvegarde trouvée pour cet identifiant.'); return; }
    const d = new Date(r.backup.date).toLocaleString('fr-FR');
    if (!confirm('Sauvegarde trouvée du '+d+'. Restaurer ? Tes données actuelles seront remplacées.')) return;
    const data = r.backup.data;
    if (data.articles) articles = await _articlesFromCloud(data.articles);
    if (data.futurs) futurs = data.futurs;
    if (data.tracking) tracking = data.tracking;
    if (data.vendeurs) localStorage.setItem('rt-vendeurs', JSON.stringify(data.vendeurs));
    if (data.pays) localStorage.setItem('rt-pay', JSON.stringify(data.pays));
    if (data.objectif) { objectif = data.objectif; localStorage.setItem('rt-obj', objectif); }
    localStorage.setItem('rt-cloud-key', k);
    save();
    showScreen('dashboard');
    alert('✅ Données restaurées depuis le cloud !');
  } catch(e) { alert('Erreur : '+e.message); }
}


// ── 🔥 RESET COMPLET (local + cloud)
async function resetAll(){
  if(!confirm('⚠️ ATTENTION : Cette action va EFFACER TOUTES tes données :\n\n• Stock local (articles, ventes, achats futurs)\n• Sauvegarde cloud Cloudflare\n• Vendeurs, paiements, objectifs\n\nCette action est IRREVERSIBLE. Continuer ?'))return;
  if(!confirm('Vraiment SÛR ? Tape OK pour confirmer la suppression définitive.'))return;
  // Nettoyer localStorage
  ['rt-art','rt-fut','rt-trk','rt-pay','rt-vendeurs','rt-obj','rt-cloud-last'].forEach(k=>localStorage.removeItem(k));
  // Reset variables globales
  articles=[];futurs=[];tracking=[];objectif=0;
  // Nettoyer le cloud
  const key=localStorage.getItem('rt-cloud-key');
  if(key){
    try{
      await fetch(CLOUD_URL,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({_action:'backup',_key:key,_data:{articles:[],futurs:[],tracking:[],vendeurs:[],pays:[],objectif:0}})
      });
    }catch(e){console.log('Cloud reset failed:',e);}
  }
  save();
  alert('✅ Tout a été effacé. Tu repars sur des bases propres !');
  closeM('mSettings');
  renderDashboard();renderStock();renderVentes();renderFuturs();
}


// ── 🔄 MIGRATION : upload toutes les photos locales (IDB + data URLs) vers R2

// Auto-backup cloud SMART - vérifie le cloud avant de push pour ne pas écraser les modifs d'un autre appareil
let _cloudPending = false;
function scheduleCloudBackup() {
  if (_cloudPending) return;
  _cloudPending = true;
  setTimeout(async () => {
    _cloudPending = false;
    const cloudKey = localStorage.getItem('rt-cloud-key');
    if (!cloudKey) return;
    
    // ✅ AVANT de push, vérifier si le cloud a été modifié par un autre appareil
    try {
      const resp = await fetch(CLOUD_URL, {method:'POST', body:JSON.stringify({_action:'restore',_key:cloudKey})});
      const r = await resp.json();
      if (r.backup && r.backup.date) {
        const cloudTime = new Date(r.backup.date).getTime();
        const lastSync = localStorage.getItem('rt-cloud-last') ? new Date(localStorage.getItem('rt-cloud-last')).getTime() : 0;
        
        if (cloudTime > lastSync + 2000) {
          // ⚠️ Le cloud a été modifié par un autre appareil ! Restaurer plutôt qu'écraser
          const d = r.backup.data;
          if (d.articles) articles = await _articlesFromCloud(d.articles);
          if (d.futurs) futurs = d.futurs;
          if (d.tracking) tracking = d.tracking;
          if (d.vendeurs) localStorage.setItem('rt-vendeurs', JSON.stringify(d.vendeurs));
          if (d.pays) localStorage.setItem('rt-pay', JSON.stringify(d.pays));
          if (d.objectif !== undefined) { objectif = d.objectif; localStorage.setItem('rt-obj', objectif); }
          localStorage.setItem('rt-cloud-last', r.backup.date);
          // Sauvegarder localStorage directement sans appeler save() pour éviter une boucle
          localStorage.setItem('rt-art', JSON.stringify(articles));
          localStorage.setItem('rt-fut', JSON.stringify(futurs));
          localStorage.setItem('rt-trk', JSON.stringify(tracking));
          localStorage.setItem('rt-saved-at', new Date().toISOString());
          showToast('☁️ Synchronisé (' + articles.length + ' articles)');
          renderDashboard(); renderStock(); renderVentes(); renderFuturs();
          return;
        }
      }
    } catch(e) { console.warn('Pre-push check failed:', e); }
    
    // ✅ Pas de conflit, on peut push notre version
    const success = await cloudBackup(true);
    if (success) {
      showToast('☁️ Paires synchronisées dans le cloud');
    }
  }, 1000);
}


// ── COULEURS
const COULEURS=[
  {l:'Blanc',c:'#f5f5f5'},{l:'Noir',c:'#222'},{l:'Gris',c:'#888'},{l:'Beige',c:'#d4b896'},
  {l:'Marron',c:'#8B4513'},{l:'Crème',c:'#FFFDD0'},{l:'Rouge',c:'#e74c3c'},{l:'Rose',c:'#ff69b4'},{l:'Corail',c:'#FF6B6B'},
  {l:'Orange',c:'#f39c12'},{l:'Jaune',c:'#f1c40f'},{l:'Vert',c:'#2ecc71'},{l:'Kaki',c:'#8B8B00'},
  {l:'Bleu',c:'#3498db'},{l:'Marine',c:'#001f5b'},{l:'Violet',c:'#9b59b6'},
  {l:'Multicolore',c:'#ff69b4'},{l:'\uD83D\uDC06 L\u00e9opard',c:'#D4A017'},{l:'\uD83E\uDD92 Girafe',c:'#C68E1A'},
  {l:'\uD83E\uDD93 Z\u00e8bre',c:'#555'},{l:'\uD83D\uDC0D Python',c:'#6B8E23'},{l:'\uD83D\uDC0A Crocodile',c:'#2D5016'},
  {l:'Tie-dye',c:'#FF69B4'},{l:'Rayures',c:'#4466aa'},{l:'Carreaux',c:'#aa4444'},
  {l:'Fleurs',c:'#FF85A1'},{l:'Camouflage',c:'#4B5320'},{l:'✨ Argent',c:'#E8E8E8'},
  {l:'💛 Doré',c:'#FFD700'},{l:'✨ Paillettes',c:'#E6D5B8'},
];

// ── 🏷️ LISTE DE MARQUES (autocomplete + persistance)
function getMarques(){
  try{return JSON.parse(localStorage.getItem('rt-marques')||'[]');}catch(e){return [];}
}
function addMarque(nom){
  if(!nom||!nom.trim())return;
  nom=nom.trim();
  const marques=getMarques();
  if(!marques.some(m=>m.toLowerCase()===nom.toLowerCase())){
    marques.push(nom);
    marques.sort();
    localStorage.setItem('rt-marques',JSON.stringify(marques));
    renderMarquesDatalist();
  }
}
function renderMarquesDatalist(){
  // Marques par défaut + ajoutées + déjà présentes dans les articles
  const defaults=['Nike','Adidas','New Balance','Asics','Puma','Reebok','Converse','Vans','Jordan','Yeezy','Lacoste','Gucci','Louis Vuitton','Balenciaga','Fila'];
  const stored=getMarques();
  const fromArticles=[...new Set(articles.map(a=>a.marque).filter(Boolean))];
  const all=[...new Set([...defaults,...stored,...fromArticles])].sort();
  const dl=document.getElementById('marquesList');
  if(dl)dl.innerHTML=all.map(m=>'<option value="'+m.replace(/"/g,'&quot;')+'">').join('');
}
// Sauvegarder la marque à l'enregistrement

function initColorPicker(){document.getElementById('colorPicker').innerHTML=COULEURS.map((c,i)=>`<button type="button" class="cpill" onclick="toggleColor(${i},this)"><span class="cswatch" style="background:${c.c}"></span>${c.l}</button>`).join('');}
function toggleColor(i,el){const lbl=COULEURS[i].l;const idx=selectedColors.indexOf(lbl);if(idx>=0){selectedColors.splice(idx,1);el.classList.remove('on');}else{selectedColors.push(lbl);el.classList.add('on');}checkPvBas();}
function getSelectedColors(){const custom=document.getElementById('f-couleur-custom').value.trim();return[...selectedColors,...(custom?[custom]:[])].join(', ');}
function resetColorPicker(){selectedColors=[];document.querySelectorAll('#colorPicker .cpill').forEach(el=>el.classList.remove('on'));document.getElementById('f-couleur-custom').value='';}

// ── NAVIGATION
function showScreen(name){
  document.querySelectorAll('.scr').forEach(s=>s.classList.remove('on'));
  document.querySelectorAll('.tbb').forEach(b=>b.classList.remove('on'));
  document.getElementById('screen-'+name).classList.add('on');
  const tabs=['dashboard','stock','ventes','futurs','historique'];
  const idx=tabs.indexOf(name);if(idx>=0)document.querySelectorAll('.tbb')[idx].classList.add('on');
  document.querySelector('.fab').style.display=['tracking','planning','paiements','marche','vendeurs'].includes(name)?'none':'flex';
  const renders={dashboard:renderDashboard,stock:renderStock,ventes:renderVentes,futurs:renderFuturs,historique:renderHisto,tracking:renderTracking,planning:renderCalendar,paiements:renderPaiements,marche:renderMarche,vendeurs:renderVendeurs};
  if(renders[name])renders[name]();updateHeader();
}
function updateHeader(){const now=new Date();document.getElementById('hdrSub').textContent=now.toLocaleDateString('fr-FR',{month:'long',year:'numeric'}).replace(/^\w/,c=>c.toUpperCase());updateObj();}

// ── OBJECTIF
function openObjModal(){document.getElementById('objInput').value=objectif||'';openM('mObj');}
function saveObj(){objectif=parseFloat(document.getElementById('objInput').value)||0;localStorage.setItem('rt-obj',objectif);closeM('mObj');updateObj();}
function updateObj(){const wrap=document.getElementById('objWrap');if(!objectif){wrap.style.display='none';return;}wrap.style.display='block';const key=new Date().toISOString().slice(0,7);let ben=0;articles.filter(a=>a.statut==='vendu'&&a.dateVente&&a.dateVente.startsWith(key)).forEach(a=>{const r=calcMarge(a);if(r)ben+=r.net;});const pct=Math.min(100,Math.round(ben/objectif*100));document.getElementById('objLbl').textContent=`Objectif ${fmtP(objectif)} \u2014 ${fmtP(ben)}`;document.getElementById('objPct').textContent=pct+'%';document.getElementById('objFill').style.width=pct+'%';}

// ── MODALES
function openM(id){document.getElementById(id).classList.add('on');}
function closeM(id){document.getElementById(id).classList.remove('on');}
document.querySelectorAll('.mbg').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('on');}));
function openAddModal(){
  if(document.getElementById('screen-futurs').classList.contains('on')){openM('mFutur');return;}
  addPhotos=[];selectedColors=[];
  ['f-nom','f-marque','f-modele','f-taille','f-taillecm','f-pa','f-pvc','f-notes','f-tracking','f-vendeur','f-comment-vendeur'].forEach(id=>document.getElementById(id).value='');if(document.getElementById('f-statut'))document.getElementById('f-statut').value='stock';document.getElementById('f-port').value='0';document.getElementById('f-quantite').value='1';document.getElementById('f-boite').value='marques';document.getElementById('f-note-vendeur').value='5';
  document.getElementById('f-date').value=new Date().toISOString().split('T')[0];
  document.getElementById('addPhotos').innerHTML='';document.getElementById('margePreview').innerHTML='';
  document.getElementById('pvBasAlert').innerHTML='';document.getElementById('importStatus').innerHTML='';
  document.getElementById('mAddTitle').textContent='Nouvel article';
  resetColorPicker();openM('mAdd');
}
function openGal(){
  const el=document.getElementById('piGal');
  if(el){el.removeAttribute('capture');el.setAttribute('accept','image/*');el.click();}
}

// ── PHOTOS
async function handlePhotos(e){
  const files=Array.from(e.target.files);
  e.target.value='';
  if(!files.length)return;
  const status=document.getElementById('importStatus');
  if(status)status.innerHTML='<div style="margin-top:8px;font-size:12px;color:var(--blue)"><span class="spin"></span>Traitement de '+files.length+' photo(s)...</div>';
  const empty = !document.getElementById('f-nom').value.trim() && !document.getElementById('f-marque').value.trim();
  const shouldAnalyze = addPhotos.length === 0 && empty;
  for(let i=0;i<files.length;i++){
    const file=files[i];
    if(i===0 && shouldAnalyze){
      await importUniversalFromFile(file);
    } else {
      // Compression + upload vers R2 (multi-device) avec fallback IDB
      const dataURL=await compressPhoto(file,1200,0.85);
      if(dataURL){
        // Tentative R2 d'abord
        const r2Url=await uploadPhotoToR2(dataURL);
        if(r2Url){
          addPhotos.push(r2Url);
          // Aussi en cache local pour rapidité
          _photoCache[r2Url]=dataURL;
        }else{
          // Fallback : IndexedDB local
          const id=await storePhoto(dataURL);
          addPhotos.push(id);
        }
        renderAddPhotos();
      }
    }
  }
  if(status)setTimeout(()=>{if(status.innerHTML.includes("Traitement"))status.innerHTML="";},600);
}
function renderAddPhotos(){document.getElementById('addPhotos').innerHTML=addPhotos.map((p,i)=>`<div class="mpt"><img src="${getPhotoURL(p)}"><button onclick="addPhotos.splice(${i},1);renderAddPhotos()">x</button></div>`).join('');}

// ── IMPORT IA
// ── 🗜️ Compression universelle des photos (évite quota localStorage iOS)
function compressPhoto(fileOrDataURL, maxSize=600, quality=0.5){
  return new Promise(resolve=>{
    const img=new Image();
    img.onload=()=>{
      const canvas=document.createElement('canvas');
      let w=img.width,h=img.height;
      // Réduction proportionnelle
      if(w>maxSize||h>maxSize){
        if(w>h){h=Math.round(h*maxSize/w);w=maxSize;}
        else{w=Math.round(w*maxSize/h);h=maxSize;}
      }
      canvas.width=w;canvas.height=h;
      const ctx=canvas.getContext('2d');
      ctx.fillStyle='#fff';ctx.fillRect(0,0,w,h); // fond blanc pour JPEG
      ctx.drawImage(img,0,0,w,h);
      const dataURL=canvas.toDataURL('image/jpeg',quality);
      resolve(dataURL);
    };
    img.onerror=()=>resolve(null);
    if(typeof fileOrDataURL==='string')img.src=fileOrDataURL;
    else{
      const url=URL.createObjectURL(fileOrDataURL);
      img.src=url;
      // Cleanup après chargement
      const orig=img.onload;
      img.onload=function(){URL.revokeObjectURL(url);orig();};
    }
  });
}

async function compressImage(file){
  // Pour l'IA : 800px qualité 0.7 (lisibilité)
  const dataURL=await compressPhoto(file,800,0.7);
  return dataURL?dataURL.split(',')[1]:null;
}

// ── IMPORT UNIVERSEL (étiquette, commande Hacoo/Yep, photo produit, code-barres)
async function importUniversal(e){
  const file=e.target.files[0];if(!file)return;
  await importUniversalFromFile(file);
  e.target.value='';
}
async function importUniversalFromFile(file){
  const status=document.getElementById('importStatus');
  status.innerHTML='<div style="margin-top:8px;font-size:12px;color:var(--purple)"><span class="spin"></span>Analyse en cours…</div>';
  try{
    const b64=await compressImage(file);
    if(!b64){status.innerHTML='<div style="margin-top:8px;font-size:12px;color:var(--red)">Impossible de lire l\'image.</div>';return;}
    const resp=await fetch('https://resell-proxy.tony-philippot.workers.dev',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens:700,
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
          {type:'text',text:'Analyse cette image. Elle peut être : (1) une commande Hacoo ou YepExpress, (2) une étiquette de chaussure/vêtement, (3) une photo de produit, (4) un code-barres. Extrait TOUT ce que tu vois. Pour le NOM, donne le nom commercial complet et lisible AVEC la couleur (ex: "New Balance 9060 Blanche", "Nike Air Max Dawn Beige"). Pour le MODELE, donne UNIQUEMENT la référence/code produit (ex: "9060 NRJ", "DM8261-001", "U9060NRJ"). Reponds UNIQUEMENT en JSON valide sans backticks: {"nom":"nom commercial complet avec couleur","marque":"marque ex New Balance Nike Adidas ou vide","modele":"reference/code produit uniquement ex 9060NRJ DM8261-001 ou vide","taille":"taille EU ex 38 ou vide","tailleCm":"taille en cm ex 24.5 ou vide - cherche la ligne CM","couleur":"couleur principale ex Blanc Noir Gris ou vide","pa":"prix paye en nombre decimal ex 42.74 ou 0","port":"frais port en nombre decimal ou 0","tracking":"numero suivi si visible sinon vide","plateforme":"Hacoo ou YepExpress si visible sinon Hacoo","ean":"code barres EAN si lisible sinon vide"}'}
        ]}]
      })
    });
    if(!resp.ok){throw new Error('HTTP '+resp.status);}
    const data=await resp.json();
    if(data.error){throw new Error(JSON.stringify(data.error));}
    const txt=data.content[0].text.replace(/```json|```/g,'').trim();
    const r=JSON.parse(txt);
    // ── PRIORITÉ : la lecture visuelle est la source principale
    if(r.nom)document.getElementById('f-nom').value=r.nom;
    if(r.marque)document.getElementById('f-marque').value=r.marque;
    if(r.modele)document.getElementById('f-modele').value=r.modele;
    if(r.taille)document.getElementById('f-taille').value=r.taille;
    if(r.tailleCm)document.getElementById('f-taillecm').value=r.tailleCm;
    if(r.pa&&r.pa!='0')document.getElementById('f-pa').value=r.pa;
    if(r.port&&r.port!='0')document.getElementById('f-port').value=r.port;
    if(r.tracking)document.getElementById('f-tracking').value=r.tracking;
    if(r.couleur){
      const cl=r.couleur.toLowerCase();
      COULEURS.forEach((c,i)=>{
        if(cl.includes(c.l.replace(/[^\w\s]/g,'').trim().toLowerCase())){
          const btn=document.querySelectorAll('#colorPicker .cpill')[i];
          if(btn&&!selectedColors.includes(c.l)){selectedColors.push(c.l);btn.classList.add('on');}
        }
      });
      if(!selectedColors.length)document.getElementById('f-couleur-custom').value=r.couleur;
    }
    // Upload R2 (multi-device) avec fallback IDB
    const storedURL=await compressPhoto(file,1200,0.85);
    if(storedURL){
      const r2Url=await uploadPhotoToR2(storedURL);
      if(r2Url){
        addPhotos.push(r2Url);
        _photoCache[r2Url]=storedURL;
      }else{
        const id=await storePhoto(storedURL);
        addPhotos.push(id);
      }
      renderAddPhotos();
    }
    updateMargePreview();
    // ── Photo = lecture visuelle UNIQUEMENT. L'EAN n'est PAS utilisé.
    //    (pour identifier via EAN, l'utilisateur clique sur le bouton dédié "Code-barres")
    const filled=[r.nom,r.marque,r.taille,r.tailleCm,r.couleur,r.pa>0?'PA':''].filter(Boolean);
    status.innerHTML=filled.length
      ?'<div style="margin-top:8px;font-size:12px;color:var(--green)">✅ Importé ! Vérifie et complète.</div>'
      :'<div style="margin-top:8px;font-size:12px;color:var(--amber)">⚠️ Rien extrait, photo illisible ?</div>';
    setTimeout(()=>{const s=document.getElementById('importStatus');if(s)s.innerHTML='';},5000);
  }catch(err){
    console.error('Import error:',err);
    status.innerHTML='<div style="margin-top:8px;font-size:12px;color:var(--red)">Erreur: '+err.message+'</div>';
  }
}
// ── QR SCANNER
async function openQrScanner(){
  document.getElementById('qrScannerWrap').style.display='block';
  try{qrStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment'}});const v=document.getElementById('qrVideo');v.srcObject=qrStream;qrInterval=setInterval(()=>{if(!v.videoWidth)return;const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);const img=c.getContext('2d').getImageData(0,0,c.width,c.height);const code=jsQR(img.data,img.width,img.height);if(code){document.getElementById('f-tracking').value=code.data;closeQrScanner();}},300);}
  catch(e){document.getElementById('qrScannerWrap').style.display='none';alert('Camera inaccessible.');}
}
function closeQrScanner(){clearInterval(qrInterval);if(qrStream)qrStream.getTracks().forEach(t=>t.stop());qrStream=null;qrInterval=null;document.getElementById('qrScannerWrap').style.display='none';}

// ── SCANNER CODE-BARRES EAN (BarcodeDetector natif + fallback IA)
let barcodeStream=null,barcodeInterval=null,_barcodeDetector=null;
function _createBarcodeDetector(){
  if(!('BarcodeDetector' in window))return null;
  try{return new BarcodeDetector({formats:['ean_13','ean_8','upc_a','upc_e','code_128','code_39','itf']});}
  catch(e){return null;}
}
async function openBarcodeScanner(){
  document.getElementById('barcodeScannerWrap').style.display='block';
  document.getElementById('barcodeStatus').innerHTML='';
  _barcodeDetector=_createBarcodeDetector();
  try{
    barcodeStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:'environment',width:{ideal:1280},height:{ideal:720}}});
    const v=document.getElementById('barcodeVideo');v.srcObject=barcodeStream;await v.play();
    if(_barcodeDetector){
      document.getElementById('barcodeStatus').innerHTML='<span style="font-size:11px;color:var(--text2)">🔍 Pointe vers le code-barres de la boîte…</span>';
      barcodeInterval=setInterval(async()=>{
        if(!v.videoWidth)return;
        try{
          const codes=await _barcodeDetector.detect(v);
          if(codes.length>0){closeBarcodeScanner();await identifyBarcode(codes[0].rawValue);}
        }catch(e){}
      },400);
    }else{
      // Fallback : bouton photo → IA lit le code
      setTimeout(()=>{
        if(document.getElementById('barcodeScannerWrap').style.display!=='none')
          document.getElementById('barcodeStatus').innerHTML='<div style="margin-top:6px"><button class="bsmall p" style="width:100%;padding:9px;border-radius:8px" onclick="captureBarcodeFallback()">📸 Photographier le code</button></div>';
      },1500);
    }
  }catch(e){document.getElementById('barcodeScannerWrap').style.display='none';alert('Caméra inaccessible.');}
}
function closeBarcodeScanner(){
  clearInterval(barcodeInterval);
  if(barcodeStream)barcodeStream.getTracks().forEach(t=>t.stop());
  barcodeStream=null;barcodeInterval=null;_barcodeDetector=null;
  document.getElementById('barcodeScannerWrap').style.display='none';
}
async function captureBarcodeFallback(){
  const v=document.getElementById('barcodeVideo');if(!v||!v.videoWidth)return;
  const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;
  c.getContext('2d').drawImage(v,0,0);
  const b64=c.toDataURL('image/jpeg',0.85).split(',')[1];
  closeBarcodeScanner();
  const status=document.getElementById('barcodeStatus');
  status.innerHTML='<span class="spin"></span> Lecture IA du code-barres…';
  try{
    const resp=await fetch('https://resell-proxy.tony-philippot.workers.dev',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:80,
        messages:[{role:'user',content:[
          {type:'image',source:{type:'base64',media_type:'image/jpeg',data:b64}},
          {type:'text',text:'Lis le code-barres EAN/UPC dans cette image. Reponds UNIQUEMENT avec le numero, rien dautre.'}
        ]}]
      })
    });
    const data=await resp.json();
    const ean=(data.content[0].text||'').trim().replace(/[^0-9]/g,'');
    if(ean&&ean.length>=8)await identifyBarcode(ean);
    else status.innerHTML='<div style="color:var(--red);font-size:12px">❌ Code non détecté. Réessaie.</div>';
  }catch(e){status.innerHTML='<div style="color:var(--red);font-size:12px">Erreur: '+e.message+'</div>';}
}
async function identifyBarcode(ean){
  const status=document.getElementById('barcodeStatus');
  status.innerHTML='<span class="spin"></span> Identification en cours…';
  try{
    const resp=await fetch('https://resell-proxy.tony-philippot.workers.dev',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:300,
        messages:[{role:'user',content:'Code EAN/UPC: '+ean+'. Identifie ce produit (sneakers ou vêtement probable). Reponds UNIQUEMENT en JSON: {"nom":"nom complet","marque":"marque","modele":"modele","categorie":"Chaussures ou Vetements ou Sacs ou Accessoires"}'}]
      })
    });
    const data=await resp.json();
    const r=JSON.parse(data.content[0].text.replace(/```json|```/g,'').trim());
    if(r.nom)document.getElementById('f-nom').value=r.nom;
    if(r.marque)document.getElementById('f-marque').value=r.marque;
    if(r.modele)document.getElementById('f-modele').value=r.modele;
    if(r.categorie){
      const sel=document.getElementById('f-cat');
      for(let i=0;i<sel.options.length;i++){if(sel.options[i].value===r.categorie){sel.selectedIndex=i;break;}}
    }
    status.innerHTML='<div style="color:var(--green);font-size:12px">✅ EAN '+ean+' identifié !</div>';
  }catch(e){
    status.innerHTML='<div style="color:var(--red);font-size:12px">EAN '+ean+' non reconnu. Remplis manuellement.</div>';
  }
}

// ── ARTICLE CRUD
let _savingArticle=false;
function saveArticle(){
  if(_savingArticle)return; // 🔒 anti-double-clic
  const nom=document.getElementById('f-nom').value.trim();if(!nom){alert('Entrez un nom');return;}
  if(addPhotos.length===0){
    if(!confirm('📸 Tu n\'as pas ajouté de photo ! Continuer sans photo ?'))return;
  }
  const modele=document.getElementById('f-modele').value.trim().toLowerCase();
  const taille=document.getElementById('f-taille').value.trim().toLowerCase();
  const doublons=articles.filter(a=>!['vendu','retour'].includes(a.statut)&&a.nom.toLowerCase()===nom.toLowerCase()&&(!taille||(a.taille||'').toLowerCase()===taille));
  if(doublons.length>0){
    if(!confirm('⚠️ "'+nom+(taille?' taille '+taille:'')+'" est déjà dans ton stock ! Tu veux vraiment l\'ajouter en double ?'))return;
  }
  const pa=parseFloat(document.getElementById('f-pa').value)||0;
  const port=parseFloat(document.getElementById('f-port').value)||0;
  const trackingNum=document.getElementById('f-tracking').value;
  const quantite=Math.max(1,parseInt(document.getElementById('f-quantite').value)||1);
  const marqueVal=document.getElementById('f-marque').value;if(marqueVal)addMarque(marqueVal);const baseArt={nom,photos:[...addPhotos],marque:marqueVal,modele:document.getElementById('f-modele').value,taille:document.getElementById('f-taille').value,tailleCm:document.getElementById('f-taillecm').value,couleur:getSelectedColors(),categorie:document.getElementById('f-cat').value,plateforme:document.getElementById('f-plat').value,statut:(document.getElementById('f-statut')?document.getElementById('f-statut').value:'stock'),vinted:document.getElementById('f-vinted').value,best:document.getElementById('f-best').value==='1',pa,port,pvcible:parseFloat(document.getElementById('f-pvc').value)||0,date:document.getElementById('f-date').value,notes:document.getElementById('f-notes').value,boite:document.getElementById('f-boite').value||'marques',vendeur:document.getElementById('f-vendeur').value||'',noteVendeur:document.getElementById('f-note-vendeur').value||'',commentVendeur:document.getElementById('f-comment-vendeur').value||'',pv:null,portVente:null,dateVente:null,retour:false};
  if(baseArt.vendeur && estBlackliste(baseArt.vendeur)){
    if(!confirm('🚫 ATTENTION ! "'+baseArt.vendeur+'" est dans ta blacklist ! Tu veux quand meme ajouter cet article ?'))return;
  }
  // Création de N articles identiques (quantite)
  _savingArticle=true;
  for(let i=0;i<quantite;i++){
    const art={...baseArt,id:Date.now().toString()+'_'+i+'_'+Math.random().toString(36).slice(2,6),trackingNum:(i===0)?trackingNum:''};
    articles.push(art);
    if(i===0 && trackingNum)tracking.push({id:Date.now().toString()+'t',nom:art.nom,num:trackingNum,carrier:'Mondial Relay',date:art.date,step:2,eta:''});
    if(art.vendeur && i===0){
      ajouterOuMajVendeur(art.vendeur, art.noteVendeur, art.commentVendeur, art.id);
    }
  }
  save();
  showToast('✅ '+(quantite>1?quantite+' paires':'Paire')+' ajoutée'+(quantite>1?'s':'')+' au stock');
  closeM('mAdd');
  renderStock();renderDashboard();
  setTimeout(()=>{_savingArticle=false;},500);
}

function dupliquerArticle(){
  const a=articles.find(x=>x.id===currentId);if(!a)return;
  if(!confirm('Dupliquer "'+a.nom+'" ?'))return;
  // PHOTOS
  addPhotos=[...(a.photos||[])];
  selectedColors=a.couleur?a.couleur.split(', ').filter(c=>COULEURS.some(x=>x.l===c)):[];
  // CHAMPS PRINCIPAUX
  document.getElementById('f-nom').value=a.nom||'';
  document.getElementById('f-marque').value=a.marque||'';
  document.getElementById('f-modele').value=a.modele||'';
  document.getElementById('f-taille').value=a.taille||'';
  document.getElementById('f-taillecm').value=a.tailleCm||'';
  document.getElementById('f-pa').value=a.pa||'';
  document.getElementById('f-port').value=a.port||0;
  document.getElementById('f-pvc').value=a.pvcible||'';
  document.getElementById('f-notes').value=a.notes||'';
  document.getElementById('f-date').value=new Date().toISOString().split('T')[0];
  document.getElementById('f-tracking').value=''; // tracking VIDE pour nouvelle commande
  document.getElementById('f-quantite').value=1;
  // CHAMPS QUI MANQUAIENT
  if(document.getElementById('f-cat')&&a.categorie)document.getElementById('f-cat').value=a.categorie;
  if(document.getElementById('f-plat')&&a.plateforme)document.getElementById('f-plat').value=a.plateforme;
  if(document.getElementById('f-vinted')&&a.vinted)document.getElementById('f-vinted').value=a.vinted;
  if(document.getElementById('f-boite')&&a.boite)document.getElementById('f-boite').value=a.boite;
  if(document.getElementById('f-vendeur'))document.getElementById('f-vendeur').value=a.vendeur||'';
  if(document.getElementById('f-note-vendeur')&&a.noteVendeur)document.getElementById('f-note-vendeur').value=a.noteVendeur;
  if(document.getElementById('f-comment-vendeur'))document.getElementById('f-comment-vendeur').value=a.commentVendeur||'';
  if(document.getElementById('f-couleur-custom'))document.getElementById('f-couleur-custom').value='';
  document.getElementById('importStatus').innerHTML='';
  document.querySelectorAll('#colorPicker .cpill').forEach((el,i)=>{if(selectedColors.includes(COULEURS[i].l))el.classList.add('on');else el.classList.remove('on');});
  renderAddPhotos();updateMargePreview();
  document.getElementById('mAddTitle').textContent='Duplication - '+a.nom;
  closeM('mDetail');openM('mAdd');
}
function suppArticle(){
  const art=articles.find(a=>a.id===currentId);
  if(!art)return;
  if(!confirm('Supprimer définitivement "'+art.nom+'" ?'))return;
  articles=articles.filter(a=>a.id!==currentId);
  save();
  showToast('🗑️ Paire supprimée');
  closeM('mDetail');
  renderStock();renderDashboard();renderVentes();
}
let _selling=false;
function marquerVendu(){
  if(_selling)return; // 🔒 anti-double-clic
  const pv=parseFloat(document.getElementById('dPv').value);if(!pv){alert('Entrez le PV');return;}
  const art=articles.find(a=>a.id===currentId);if(!art)return;
  if(art.statut==='vendu'){alert('Cette paire est déjà vendue !');return;}
  _selling=true;
  art.pv=pv;art.portVente=0;
  art.vinted=document.getElementById('dVinted').value;art.statut='vendu';art.dateVente=document.getElementById('dDateVente').value||art.dateVente||new Date().toISOString().split('T')[0];
  const r=calcMarge(art);
  if(r){const pays=JSON.parse(localStorage.getItem('rt-pay')||'[]');pays.push({id:Date.now().toString(),artId:art.id,nom:art.nom,vinted:art.vinted,montant:art.pv,net:r.net,date:art.dateVente,recu:false});localStorage.setItem('rt-pay',JSON.stringify(pays));}
  save();
  showToast('💰 Vendue à '+pv+'€ !');
  closeM('mDetail');
  renderStock();renderDashboard();renderVentes();
  setTimeout(()=>{_selling=false;},500);
}
function racheterArticle(){
  const a=articles.find(x=>x.id===currentId);if(!a)return;
  if(!confirm('Recréer "'+a.nom+'" comme nouvel achat ?'))return;
  const art={
    id:Date.now().toString(),nom:a.nom,photos:[...a.photos],
    marque:a.marque||'',modele:a.modele||'',taille:a.taille||'',
    tailleCm:a.tailleCm||'',couleur:a.couleur||'',
    categorie:a.categorie||'Chaussures',plateforme:a.plateforme||'Hacoo',
    statut:'stock',vinted:a.vinted||'tony',best:false,
    trackingNum:'',pa:a.pa||0,port:a.port||0,pvcible:a.pvcible||0,
    date:new Date().toISOString().split('T')[0],
    notes:a.notes||'',boite:'marques',vendeur:a.vendeur||'',
    noteVendeur:'',commentVendeur:'',
    pv:null,portVente:null,dateVente:null,retour:false
  };
  articles.push(art);
  save();closeM('mDetail');renderStock();renderDashboard();
  alert('✅ Article recréé dans ton stock !');
}


// ── 🔄 Changement de statut depuis le détail
function changeStatut(newStatut){
  const art=articles.find(a=>a.id===currentId);if(!art)return;
  art.statut=newStatut;
  const today=new Date().toISOString().split('T')[0];
  // 📦 Réception : si on passe en stock et pas de date réception, on la met aujourd'hui
  if(newStatut==='stock'&&!art.dateRecu)art.dateRecu=today;
  // 🏷️ Mise en vente : si on passe en vente et pas de date, on la met aujourd'hui
  if(newStatut==='vente'&&!art.dateMiseEnVente)art.dateMiseEnVente=today;
  // Si on passe en attente/stock/vente, retirer les infos de vente
  if(['attente','stock','vente'].includes(newStatut)){
    art.retour=false;
    // Garder les infos de vente précédentes au cas où (ne pas effacer pv/dateVente)
  }
  save();
  const lbls={attente:'🕐 En attente',stock:'📦 En stock',vente:'📢 En vente',vendu:'✅ Vendu',retour:'↩️ Retour'};
  showToast('Statut changé : '+lbls[newStatut]);
  renderStock();renderDashboard();renderVentes();
  openDetail(currentId); // recharge le détail
}

function marquerRetour(){const art=articles.find(a=>a.id===currentId);if(!art)return;if(!confirm('Marquer retour acheteur ?'))return;art.retour=true;art.statut='retour';art.pv=null;art.dateVente=null;save();closeM('mDetail');renderStock();renderDashboard();}

// ── CALCULS
function calcMarge(art){if(!art.pv)return null;const cout=(art.pa||0)+(art.port||0);const fraisV=0;const net=art.pv-cout;const roi=cout>0?net/cout*100:0;return{cout,fraisV,net,roi};}
function calcEst(pa,port,pv){if(!pv||!pa)return null;const cout=pa+port;const fraisV=0;const net=pv-cout;const roi=cout>0?net/cout*100:0;return{cout,fraisV,net,roi};}
function prixMin(pa,port){return Math.ceil((pa+port)*100)/100;}
function ageJours(d){if(!d)return 0;return Math.floor((new Date()-new Date(d+'T00:00:00'))/864e5);}
// 📅 Date de référence pour l'ancienneté : réception si dispo, sinon achat
function dateRef(a){return a.dateRecu||a.date;}
function ageStock(a){return ageJours(dateRef(a));}
function ageColor(j){return j<15?'var(--green)':j<30?'var(--amber)':'var(--red)';}
function scoreRentabilite(art){if(!art.pvcible)return null;const r=calcEst(art.pa||0,art.port||0,art.pvcible);if(!r)return null;if(r.roi>100)return 10;if(r.roi>70)return 9;if(r.roi>50)return 8;if(r.roi>35)return 7;if(r.roi>25)return 6;if(r.roi>15)return 5;if(r.roi>8)return 4;if(r.roi>3)return 3;if(r.roi>0)return 2;return 1;}
function fmt(v){return(v>=0?'+':'')+v.toFixed(2)+' \u20ac';}
function fmtP(v){return(v||0).toFixed(2)+' \u20ac';}
function fmtDate(d){if(!d)return'\u2014';return new Date(d+'T00:00:00').toLocaleDateString('fr-FR',{day:'numeric',month:'short'});}
function catEmoji(c){return{Chaussures:'\uD83D\uDC5F',V\u00eatements:'\uD83D\uDC57',Sacs:'\uD83D\uDC5C',Accessoires:'\u2728',Autre:'\uD83D\uDCE6'}[c]||'\uD83D\uDCE6';}
// ── 📸 Photo de couverture : la 2ème photo (chaussure) si elle existe, sinon la 1ère (étiquette)
function coverPhoto(art){
  if(!art.photos||!art.photos.length)return null;
  // Si l'utilisateur a défini une photo principale manuellement, on la respecte
  if(art.coverIndex!==undefined&&art.photos[art.coverIndex])return art.photos[art.coverIndex];
  // Sinon : 2ème photo (1ère chaussure) si dispo, sinon la 1ère
  return art.photos.length>1?art.photos[1]:art.photos[0];
}
function thumb(art){const ph=coverPhoto(art);if(ph){const url=getPhotoURL(ph);if(url)return'<img src="'+url+'">';}return catEmoji(art.categorie);}
function statLabel(s){return{attente:'En attente',stock:'En stock',vente:'En vente',vendu:'Vendu',retour:'Retour'}[s]||s;}
function vintedTag(v){if(!v)return'';return v==='tony'?'<span class="tag-tony">Tony</span>':'<span class="tag-laetitia">Laetitia</span>';}
function scoreHtml(s){if(!s)return'';const c=s>=7?'high':s>=4?'mid':'low';const e=s>=8?'\uD83D\uDD25':s>=6?'\u2705':s>=4?'\u26A0\uFE0F':'\u274C';return'<span class="score '+c+'">'+e+' '+s+'/10</span>';}
function checkPvBas(){const pa=parseFloat(document.getElementById('f-pa').value)||0;const port=parseFloat(document.getElementById('f-port').value)||0;const pvc=parseFloat(document.getElementById('f-pvc').value)||0;const box=document.getElementById('pvBasAlert');if(!pvc||!pa){box.innerHTML='';return;}const pm=prixMin(pa,port);if(pvc<pm)box.innerHTML='<div class="pvbas-banner">PV trop bas ! Min : <b>'+fmtP(pm)+'</b></div>';else box.innerHTML='';}
function updateMargePreview(){const pa=parseFloat(document.getElementById('f-pa').value)||0;const port=parseFloat(document.getElementById('f-port').value)||0;const pv=parseFloat(document.getElementById('f-pvc').value)||0;checkPvBas();const box=document.getElementById('margePreview');if(!pv||!pa){box.innerHTML='';return;}const r=calcEst(pa,port,pv);const s=scoreRentabilite({pa,port,pvcible:pv});box.innerHTML='<div class="cbox"><div class="crow"><span>Marge nette estim\u00e9e</span><span style="color:'+(r.net>=0?'var(--green)':'var(--red)')+'">'+fmt(r.net)+'</span></div><div class="crow"><span>ROI</span><span>'+r.roi.toFixed(1)+'%</span></div><div class="crow"><span>Score</span><span>'+scoreHtml(s)+'</span></div></div>';}
function updateFuturPreview(){const pa=parseFloat(document.getElementById('ff-pa').value)||0;const port=parseFloat(document.getElementById('ff-port').value)||0;const pv=parseFloat(document.getElementById('ff-pv').value)||0;const box=document.getElementById('futurPreview');if(!pv||!pa){box.innerHTML='';return;}const r=calcEst(pa,port,pv);box.innerHTML='<div class="cbox" style="margin-bottom:10px"><div class="crow"><span>Marge</span><span style="color:'+(r.net>=0?'var(--green)':'var(--red)')+'">'+fmt(r.net)+'</span></div><div class="crow"><span>ROI</span><span>'+r.roi.toFixed(1)+'%</span></div></div>';}

// ── DASHBOARD
function switchPeriod(p){
  dashPeriod=p;
  document.querySelectorAll('#periodTab .ts').forEach((el,i)=>el.classList.toggle('on',['month','year','all'][i]===p));
  renderDashboard();
}

function getFilteredVendus(){
  const now=new Date();
  const keyMonth=now.toISOString().slice(0,7);
  const keyYear=now.getFullYear().toString();
  if(dashPeriod==='month') return articles.filter(a=>a.statut==='vendu'&&a.dateVente&&a.dateVente.startsWith(keyMonth));
  if(dashPeriod==='year')  return articles.filter(a=>a.statut==='vendu'&&a.dateVente&&a.dateVente.startsWith(keyYear));
  return articles.filter(a=>a.statut==='vendu');
}

function renderDashboard(){
  const mV=getFilteredVendus();
  const periodLabel=dashPeriod==='month'?'ce mois':dashPeriod==='year'?'cette année':'tout';
  let ben=0,ca=0,bT=0,bL=0;
  mV.forEach(a=>{const r=calcMarge(a);if(r){ben+=r.net;ca+=a.pv;if(a.vinted==='tony')bT+=r.net;else if(a.vinted==='laetitia')bL+=r.net;}});
  const immo=articles.filter(a=>['attente','stock','vente'].includes(a.statut)).reduce((s,a)=>s+(a.pa||0)+(a.port||0),0);
  // Bénéfice ALL TIME
  let benTotal=0;
  articles.filter(a=>a.statut==='vendu').forEach(a=>{const r=calcMarge(a);if(r)benTotal+=r.net;});
  // Update labels
  document.querySelectorAll('#periodTab .ts').forEach((el,i)=>el.classList.toggle('on',['month','year','all'][i]===dashPeriod));
  document.getElementById('kpi-ben').textContent=fmtP(ben);document.getElementById('kpi-ca').textContent=fmtP(ca);
  document.getElementById('kpi-immo').textContent=fmtP(immo);document.getElementById('kpi-vnd').textContent=mV.length;
  const allTimeEl=document.getElementById('kpi-alltime');if(allTimeEl)allTimeEl.textContent=fmtP(benTotal);
  document.getElementById('kpi-tony').textContent=fmtP(bT);document.getElementById('kpi-laet').textContent=fmtP(bL);
  // 💸 Total dépensé (PA + port de TOUTES les paires, y compris vendues/retours)
  let totalDepense=0;
  articles.forEach(a=>{
    const p=(a.plateforme||'').toLowerCase();
    if(p.includes('hacoo')||p.includes('yep')||p===''){
      totalDepense+=(a.pa||0)+(a.port||0);
    }
  });
  const dEl=document.getElementById('kpi-depense');if(dEl)dEl.textContent=fmtP(totalDepense);
  const rappels=articles.filter(a=>['stock','vente'].includes(a.statut)&&a.date&&ageJours(a.date)>30);
  const rappelsMise=articles.filter(a=>a.statut==='stock'&&a.date&&ageJours(a.date)>3&&ageJours(a.date)<=30);
  const pvBas=articles.filter(a=>!['vendu','retour'].includes(a.statut)&&a.pvcible&&a.pvcible<prixMin(a.pa||0,a.port||0));
  document.getElementById('rappelsBanner').innerHTML=[...rappels.slice(0,2).map(a=>'<div class="rappel" onclick="openDetail(\''+a.id+'\')">'+a.nom+' en stock depuis '+ageJours(a.date)+'j</div>'),...rappelsMise.slice(0,1).map(a=>'<div class="rappel info" onclick="openDetail(\''+a.id+'\')">'+a.nom+' recu il y a '+ageJours(a.date)+'j - mets le en vente !</div>')].join('');
  document.getElementById('pvBasBanner').innerHTML=pvBas.slice(0,2).map(a=>'<div class="pvbas-banner" onclick="openDetail(\''+a.id+'\')">PV bas : "'+a.nom+'" min '+fmtP(prixMin(a.pa||0,a.port||0))+'</div>').join('');
  const vendusMap={};articles.filter(a=>a.statut==='vendu').forEach(a=>{const k=((a.marque||'')+' '+(a.modele||a.nom)).trim();if(!vendusMap[k])vendusMap[k]={nom:k,count:0,nets:[],roi:[]};vendusMap[k].count++;const r=calcMarge(a);if(r){vendusMap[k].nets.push(r.net);vendusMap[k].roi.push(r.roi);}});
  const courses=Object.values(vendusMap).map(v=>({...v,avgRoi:v.roi.reduce((a,b)=>a+b,0)/(v.roi.length||1),avgNet:v.nets.reduce((a,b)=>a+b,0)/(v.nets.length||1)})).sort((a,b)=>b.avgRoi-a.avgRoi).slice(0,5);
  document.getElementById('listeCourses').innerHTML=!courses.length?'<div style="font-size:12px;color:var(--text2)">Vends des articles pour generer des suggestions</div>':courses.map((c,i)=>'<div class="courses-card"><div class="courses-rank">#'+(i+1)+'</div><div class="courses-info"><div class="courses-nom">'+c.nom+'</div><div class="courses-det">'+c.count+' vente'+(c.count>1?'s':'')+' - Moy '+fmtP(c.avgNet)+'</div><div class="courses-roi">ROI moy '+c.avgRoi.toFixed(1)+'% - A racheter !</div></div></div>').join('');
  const bycat={};articles.filter(a=>a.statut==='vendu'&&a.date&&a.dateVente).forEach(a=>{const c=a.categorie||'Autre';if(!bycat[c])bycat[c]=[];const j=Math.max(0,Math.floor((new Date(a.dateVente+'T00:00:00')-new Date(a.date+'T00:00:00'))/864e5));bycat[c].push(j);});
  document.getElementById('tempVente').innerHTML=!Object.keys(bycat).length?'<div style="font-size:12px;color:var(--text2)">Aucune donnee</div>':'<div class="card2">'+Object.entries(bycat).map(([c,vs])=>{const avg=Math.round(vs.reduce((a,b)=>a+b,0)/vs.length);return'<div class="vitesse-row"><span>'+catEmoji(c)+' '+c+'</span><span style="font-family:\'DM Mono\',monospace;font-weight:600;color:'+(avg<10?'var(--green)':avg<20?'var(--amber)':'var(--red)')+'">'+avg+'j</span></div>';}).join('')+'</div>';
  const tops=Object.values(vendusMap).map(v=>({...v,avgRoi:v.roi.reduce((a,b)=>a+b,0)/(v.roi.length||1)})).sort((a,b)=>b.avgRoi-a.avgRoi).slice(0,3);
  document.getElementById('topArticles').innerHTML=tops.map((t,i)=>'<div class="top-card"><div class="top-rank">#'+(i+1)+'</div><div style="flex:1"><div style="font-size:13px;font-weight:500">'+t.nom+'</div><div style="font-size:11px;color:var(--text2)">'+t.count+' vente'+(t.count>1?'s':'')+' - ROI '+t.avgRoi.toFixed(1)+'%</div></div></div>').join('');
  const last=[...articles].filter(a=>a.statut==='vendu').sort((a,b)=>(b.dateVente||'').localeCompare(a.dateVente||'')).slice(0,5);
  document.getElementById('dashSales').innerHTML=!last.length?'<div class="empty"><div class="eicon">...</div>Aucune vente</div>':last.map(a=>{const r=calcMarge(a);const m=r?r.net:0;return'<div class="irow" onclick="openDetail(\''+a.id+'\')"><div class="ithumb">'+thumb(a)+'</div><div class="iinfo"><div class="iname">'+a.nom+'</div><div class="imeta">'+a.plateforme+' '+fmtDate(a.dateVente)+'</div></div><div class="ival"><div class="marge '+(m>=0?'mp':'mn')+'">'+fmt(m)+'</div>'+vintedTag(a.vinted)+'</div></div>';}).join('');
  renderChart();updateObj();
}
function switchChart(m){chartMode=m;['ct-m','ct-a','ct-c'].forEach((id,i)=>document.getElementById(id).classList.toggle('on',['m','a','c'][i]===m));renderChart();}
function renderChart(){
  try{
  if(typeof Chart==='undefined')return;
  const canvas=document.getElementById('mainChart');if(!canvas)return;if(chartObj){chartObj.destroy();chartObj=null;}
  const now=new Date();let labels=[],datasets=[];
  const mn=['Jan','F\u00e9v','Mar','Avr','Mai','Jun','Jul','Ao\u00fb','Sep','Oct','Nov','D\u00e9c'];
  if(chartMode==='m'||chartMode==='c'){
    const dT=[],dL=[];
    for(let i=5;i>=0;i--){const d=new Date(now.getFullYear(),now.getMonth()-i,1);const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0');labels.push(mn[d.getMonth()]);let bt=0,bl=0;articles.filter(a=>a.statut==='vendu'&&a.dateVente&&a.dateVente.startsWith(k)).forEach(a=>{const r=calcMarge(a);if(!r)return;if(a.vinted==='tony')bt+=r.net;else bl+=r.net;});dT.push(parseFloat(bt.toFixed(2)));dL.push(parseFloat(bl.toFixed(2)));}
    if(chartMode==='c'){datasets=[{data:dT,backgroundColor:'rgba(77,159,255,0.7)',borderRadius:4,borderSkipped:false,label:'Tony'},{data:dL,backgroundColor:'rgba(255,107,220,0.7)',borderRadius:4,borderSkipped:false,label:'Laetitia'}];}
    else{const tot=dT.map((v,i)=>parseFloat((v+dL[i]).toFixed(2)));datasets=[{data:tot,backgroundColor:tot.map(v=>v>=0?'rgba(31,217,154,0.7)':'rgba(255,85,102,0.7)'),borderRadius:6,borderSkipped:false}];}
  }else{
    const yr=now.getFullYear();let data=[];
    for(let y=yr-2;y<=yr;y++){labels.push(y+'');let b=0;articles.filter(a=>a.statut==='vendu'&&a.dateVente&&a.dateVente.startsWith(y+'')).forEach(a=>{const r=calcMarge(a);if(r)b+=r.net;});data.push(parseFloat(b.toFixed(2)));}
    datasets=[{data,backgroundColor:data.map(v=>v>=0?'rgba(31,217,154,0.7)':'rgba(255,85,102,0.7)'),borderRadius:6,borderSkipped:false}];
  }
  // Check if all data is zero
const hasData=datasets.some(d=>(d.data||[]).some(v=>v!==0));
if(!hasData){
  try{
    const ctx2=canvas.getContext('2d');ctx2.clearRect(0,0,canvas.width,canvas.height);
    ctx2.fillStyle='#8888aa';ctx2.font='13px sans-serif';ctx2.textAlign='center';
    ctx2.fillText('Tes ventes apparaîtront ici 📈',canvas.width/2,80);
  }catch(e){}
  return;
}
chartObj=new Chart(canvas,{type:'bar',data:{labels,datasets},options:{responsive:true,plugins:{legend:{display:chartMode==='c',labels:{color:'#8888aa',font:{size:11}}}},scales:{x:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8888aa',font:{size:11}}},y:{grid:{color:'rgba(255,255,255,0.04)'},ticks:{color:'#8888aa',font:{size:11},callback:v=>v+'\u20ac'}}}}});
  }catch(e){console.error('renderChart error:',e);}
}

// ── STOCK
function setFilter(f,el,vn){
  // Mise à jour réelle des variables (window[vn] ne marche pas avec 'let')
  if(vn==='stockFilter')stockFilter=f;
  else if(vn==='futurFilter')futurFilter=f;
  else if(vn==='payTab')payTab=f;
  else window[vn]=f; // fallback
  el.closest('.pills').querySelectorAll('.pill').forEach(p=>p.classList.remove('on'));
  el.classList.add('on');
  if(vn==='stockFilter')renderStock();
  else if(vn==='futurFilter')renderFuturs();
  else if(vn==='payTab')renderPaiements();
}
function renderStock(){
  const search=(document.getElementById('stockSearch').value||'').toLowerCase();
  let arts=[...articles];
  const filters={actifs:a=>!['vendu','retour'].includes(a.statut),attente:a=>a.statut==='attente',stock:a=>a.statut==='stock',vente:a=>a.statut==='vente',vendu:a=>a.statut==='vendu',retour:a=>a.statut==='retour',Hacoo:a=>a.plateforme==='Hacoo',YepExpress:a=>a.plateforme==='YepExpress',tony:a=>a.vinted==='tony',laetitia:a=>a.vinted==='laetitia'};
  ['Chaussures','V\u00eatements','Sacs','Accessoires'].forEach(c=>{filters[c]=a=>a.categorie===c;});
  if(filters[stockFilter])arts=arts.filter(filters[stockFilter]);
  if(search)arts=arts.filter(a=>[a.nom,a.marque,a.modele,a.taille,a.couleur,a.notes].join(' ').toLowerCase().includes(search));
  // Tri par marge décroissante
  arts.sort((a,b)=>{
    const ra=a.pvcible&&a.pa?(a.pvcible-(a.pa+a.port)):null;
    const rb=b.pvcible&&b.pa?(b.pvcible-(b.pa+b.port)):null;
    if(ra===null&&rb===null)return 0;
    if(ra===null)return 1;
    if(rb===null)return -1;
    return rb-ra;
  });
  const cats={};articles.filter(a=>!['vendu','retour'].includes(a.statut)).forEach(a=>{const c=a.categorie||'Autre';if(!cats[c])cats[c]={n:0,pa:0};cats[c].n++;cats[c].pa+=(a.pa||0)+(a.port||0);});
  document.getElementById('catStats').innerHTML=Object.keys(cats).length?'<div style="display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none">'+Object.entries(cats).map(([c,v])=>'<div style="flex-shrink:0;background:var(--card);border:1px solid var(--border);border-radius:8px;padding:6px 10px;font-size:11px"><div style="color:var(--text2)">'+catEmoji(c)+' '+c+'</div><div style="font-weight:600;font-family:\'DM Mono\',monospace;margin-top:2px">'+fmtP(v.pa/v.n)+' moy</div></div>').join('')+'</div>':'';
  document.getElementById('stockGrid').innerHTML=arts.map(a=>{const j=ageJours(a.date);const s=scoreRentabilite(a);const pvBas=a.pvcible&&a.pvcible<prixMin(a.pa||0,a.port||0);const ageC=!['vendu','retour'].includes(a.statut)?ageColor(j):'transparent';return'<div class="scard" data-id="'+a.id+'" onclick="openDetail(\''+a.id+'\')"><div class="age-bar" style="background:'+ageC+'"></div><div class="sphoto">'+thumb(a)+(s?'<div class="score-dot" style="color:'+(s>=7?'var(--green)':s>=4?'var(--amber)':'var(--red)')+'">'+s+'/10</div>':'')+(a.best?'<div class="best-dot">&#11088;</div>':'')+'</div><div class="sbody"><div class="sname">'+a.nom+'</div><div class="sdet">'+([a.taille,a.couleur].filter(Boolean)[0]||a.plateforme)+'</div><div class="spa">'+fmtP(a.pa||0)+(pvBas?' &#9888;':'')+'</div>'+(a.pvcible?'<div class="smg">&#10145;'+fmtP(a.pvcible)+'</div>':'')+'<span class="bdg '+a.statut+'">'+statLabel(a.statut)+'</span>'+vintedTag(a.vinted)+'</div></div>';}).join('')+'<div class="scard sadd" onclick="openAddModal()"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><path d="M12 8v8M8 12h8"/></svg><span>Ajouter</span></div>';
}

// ── VENTES
function switchVentes(t){ventesTab=t;document.querySelectorAll('#ventesTab .ts').forEach((el,i)=>el.classList.toggle('on',['env','vnd','tony','laetitia'][i]===t));renderVentes();}
function renderVentes(){
  const list=document.getElementById('ventesList');
  const maps={env:a=>['stock','vente'].includes(a.statut),vnd:a=>a.statut==='vendu',tony:a=>a.vinted==='tony',laetitia:a=>a.vinted==='laetitia'};
  let arts=articles.filter(maps[ventesTab]||maps.env).sort((a,b)=>(b.dateVente||b.date||'').localeCompare(a.dateVente||a.date||''));
  if(!arts.length){list.innerHTML='<div class="empty"><div class="eicon">&#128717;</div>Rien ici</div>';return;}
  list.innerHTML=arts.map(a=>{const r=calcMarge(a);if((ventesTab==='vnd'||ventesTab==='tony'||ventesTab==='laetitia')&&r)return'<div class="card2" onclick="openDetail(\''+a.id+'\')"><div style="display:flex;justify-content:space-between"><div><div style="font-size:13px;font-weight:500">'+a.nom+'</div><div style="font-size:11px;color:var(--text2);margin-top:2px">'+([a.taille,a.couleur].filter(Boolean).join(' ')||a.plateforme)+' '+fmtDate(a.dateVente)+'</div>'+vintedTag(a.vinted)+'</div><div style="text-align:right"><div class="marge '+(r.net>=0?'mp':'mn')+'">'+fmt(r.net)+'</div><div style="font-size:10px;color:var(--text2)">ROI '+r.roi.toFixed(1)+'%</div></div></div><div class="cbox" style="margin-top:8px"><div class="crow"><span>PV</span><span>'+fmtP(a.pv)+'</span></div><div class="crow"><span>Frais Vinted</span><span>-'+fmtP(r.fraisV)+'</span></div><div class="crow tot"><span>Net</span><span style="color:'+(r.net>=0?'var(--green)':'var(--red)')+'">'+fmt(r.net)+'</span></div></div></div>';return'<div class="irow" onclick="openDetail(\''+a.id+'\')"><div class="ithumb">'+thumb(a)+'</div><div class="iinfo"><div class="iname">'+a.nom+'</div><div class="imeta">'+([a.taille,a.couleur].filter(Boolean).join(' ')||a.plateforme)+'</div></div><div class="ival"><div style="font-size:12px;color:var(--text2)">PA '+fmtP(a.pa||0)+'</div><div class="bdg '+a.statut+'">'+statLabel(a.statut)+'</div></div></div>';}).join('');
}

// ── FUTURS
function saveFutur(){const nom=document.getElementById('ff-nom').value.trim();if(!nom){alert('Entrez un nom');return;}futurs.push({id:Date.now().toString(),nom,pa:parseFloat(document.getElementById('ff-pa').value)||0,port:parseFloat(document.getElementById('ff-port').value)||0,pv:parseFloat(document.getElementById('ff-pv').value)||0,url:document.getElementById('ff-url').value,statut:document.getElementById('ff-stat').value,notes:document.getElementById('ff-notes').value,date:new Date().toISOString().split('T')[0]});save();closeM('mFutur');renderFuturs();}
function convertFutur(id){const f=futurs.find(x=>x.id===id);if(!f)return;articles.push({id:Date.now().toString(),nom:f.nom,photos:[],marque:'',modele:'',taille:'',couleur:'',categorie:'Autre',plateforme:'Hacoo',statut:'stock',vinted:'',trackingNum:'',pa:f.pa,port:f.port,pvcible:f.pv,date:new Date().toISOString().split('T')[0],notes:f.notes,pv:null,portVente:null,dateVente:null,best:false,retour:false});futurs=futurs.filter(x=>x.id!==id);save();renderFuturs();renderStock();alert('OK Ajoute au stock !');}
function suppFutur(id){if(!confirm('Supprimer ?'))return;futurs=futurs.filter(x=>x.id!==id);save();renderFuturs();}
function renderFuturs(){
  const list=document.getElementById('futursList');
  let fs=futurFilter==='tous'?[...futurs]:futurs.filter(f=>f.statut===futurFilter);
  fs.sort((a,b)=>{const ra=calcEst(a.pa,a.port,a.pv),rb=calcEst(b.pa,b.port,b.pv);return(rb?rb.net:-999)-(ra?ra.net:-999);});
  if(!fs.length){list.innerHTML='<div class="empty"><div class="eicon">&#128269;</div>Aucun modele<br><br><button class="bprimary" style="width:auto;padding:10px 20px" onclick="openM(\'mFutur\')">+ Ajouter</button></div>';return;}
  list.innerHTML=fs.map(f=>{const r=calcEst(f.pa,f.port,f.pv);return'<div class="fcard"><div style="display:flex;justify-content:space-between;align-items:flex-start"><div><div style="font-size:14px;font-weight:500">'+f.nom+'</div><div style="font-size:11px;color:var(--text2);margin-top:3px">PA '+fmtP(f.pa)+' PV '+fmtP(f.pv)+'</div>'+(r?'<div style="font-size:12px;font-family:\'DM Mono\',monospace;color:var(--purple);margin-top:4px">'+fmt(r.net)+' ROI '+r.roi.toFixed(1)+'%</div>':'')+'</div><span class="bdg '+f.statut+'">'+(f.statut==='tester'?'A tester':f.statut==='interessant'?'Interessant':'A eviter')+'</span></div>'+(f.notes?'<div style="font-size:11px;color:var(--text2);margin-top:6px">'+f.notes+'</div>':'')+(f.url?'<a href="'+f.url+'" class="plink" style="margin-top:6px;display:inline-block">Voir le lien</a>':'')+'<div class="factions"><button class="bsmall g" onclick="convertFutur(\''+f.id+'\')">Acheter</button><button class="bsmall" onclick="suppFutur(\''+f.id+'\')">Supprimer</button></div></div>';}).join('')+'<button class="bsec" onclick="openM(\'mFutur\')" style="margin-top:4px">+ Nouveau</button>';
}

// ── HISTORIQUE
function switchHisto(t){histoTab=t;document.querySelectorAll('#screen-historique .ts').forEach((el,i)=>el.classList.toggle('on',['m','a','f'][i]===t));renderHisto();}
function renderHisto(){
  const cont=document.getElementById('histoContent');const vendus=articles.filter(a=>a.statut==='vendu'&&a.dateVente);
  if(histoTab==='m'){
    const byM={};vendus.forEach(a=>{const k=a.dateVente.slice(0,7);if(!byM[k])byM[k]=[];byM[k].push(a);});const keys=Object.keys(byM).sort().reverse();
    if(!keys.length){cont.innerHTML='<div class="empty"><div class="eicon">&#128197;</div>Aucune vente</div>';return;}
    cont.innerHTML=keys.map(k=>{const arts=byM[k];let tot=0,ca=0;arts.forEach(a=>{const r=calcMarge(a);if(r){tot+=r.net;ca+=a.pv;}});const[y,m]=k.split('-');const nom=new Date(+y,+m-1,1).toLocaleDateString('fr-FR',{month:'long',year:'numeric'});return'<div class="mblock"><div class="mhdr"><div class="mhdr-name">'+nom.replace(/^\w/,c=>c.toUpperCase())+'</div><div class="mhdr-tot">'+fmt(tot)+'</div></div>'+arts.sort((a,b)=>b.dateVente.localeCompare(a.dateVente)).map(a=>{const r=calcMarge(a);const m2=r?r.net:0;return'<div class="irow" onclick="openDetail(\''+a.id+'\')"><div class="ithumb">'+thumb(a)+'</div><div class="iinfo"><div class="iname">'+a.nom+'</div><div class="imeta">'+([a.taille,a.couleur].filter(Boolean).join(' ')||a.plateforme)+'</div></div><div class="ival"><div class="marge '+(m2>=0?'mp':'mn')+'">'+fmt(m2)+'</div>'+vintedTag(a.vinted)+'</div></div>';}).join('')+'<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text2);padding:4px 2px"><span>'+arts.length+' article'+(arts.length>1?'s':'')+' CA '+fmtP(ca)+'</span><span>'+fmt(tot)+'</span></div></div>';}).join('');
  }else if(histoTab==='a'){
    const byY={};vendus.forEach(a=>{const y=a.dateVente.slice(0,4);if(!byY[y])byY[y]=[];byY[y].push(a);});const years=Object.keys(byY).sort().reverse();
    if(!years.length){cont.innerHTML='<div class="empty"><div class="eicon">&#128197;</div>Aucune vente</div>';return;}
    const mn=['Janvier','F\u00e9vrier','Mars','Avril','Mai','Juin','Juillet','Ao\u00fbt','Septembre','Octobre','Novembre','D\u00e9cembre'];
    cont.innerHTML=years.map(yr=>{const arts=byY[yr];let totA=0,caA=0;const byMo={};arts.forEach(a=>{const r=calcMarge(a);if(r){totA+=r.net;caA+=a.pv;}const mo=parseInt(a.dateVente.slice(5,7))-1;if(!byMo[mo])byMo[mo]={b:0,n:0};const r2=calcMarge(a);if(r2)byMo[mo].b+=r2.net;byMo[mo].n++;});return'<div class="annual-card"><div class="annual-title">'+yr+' '+arts.length+' ventes CA '+fmtP(caA)+'</div><div style="margin-bottom:12px"><div style="font-size:10px;color:var(--text2)">Benefice net</div><div style="font-size:24px;font-weight:600;font-family:\'DM Mono\',monospace;color:'+(totA>=0?'var(--green)':'var(--red)')+'">'+fmt(totA)+'</div></div>'+mn.map((n,i)=>{const d=byMo[i];if(!d)return'<div class="arow"><span class="am">'+n+'</span><span class="av z">--</span></div>';return'<div class="arow"><span class="am">'+n+' ('+d.n+')</span><span class="av '+(d.b>=0?'p':'z')+'">'+fmt(d.b)+'</span></div>';}).join('')+'</div>';}).join('');
  }else{
    const byY={};vendus.forEach(a=>{const y=a.dateVente.slice(0,4);if(!byY[y])byY[y]=[];byY[y].push(a);});const years=Object.keys(byY).sort().reverse();
    if(!years.length){cont.innerHTML='<div class="empty"><div class="eicon">&#129534;</div>Aucune donnee</div>';return;}
    cont.innerHTML=years.map(yr=>{const arts=byY[yr];let caT=0,paT=0,portT=0,fraisT=0,benT=0;arts.forEach(a=>{caT+=a.pv||0;paT+=a.pa||0;portT+=a.port||0;const r=calcMarge(a);if(r){fraisT+=r.fraisV;benT+=r.net;}});return'<div class="annual-card"><div class="annual-title">Bilan fiscal '+yr+'</div><div class="fiscal-row"><span>CA total</span><span style="font-family:\'DM Mono\',monospace">'+fmtP(caT)+'</span></div><div class="fiscal-row"><span>Achats + port</span><span style="font-family:\'DM Mono\',monospace">-'+fmtP(paT+portT)+'</span></div><div class="fiscal-row"><span>Commissions Vinted</span><span style="font-family:\'DM Mono\',monospace">-'+fmtP(fraisT)+'</span></div><div class="fiscal-row" style="font-weight:600;color:'+(benT>=0?'var(--green)':'var(--red)')+'"><span>Benefice declarable</span><span style="font-family:\'DM Mono\',monospace">'+fmt(benT)+'</span></div><div style="font-size:11px;color:var(--text2);margin-top:8px">+ de 2000 euros/an a declarer en France.</div><button class="bsmall b" onclick="exportCSV(\''+yr+'\')" style="margin-top:10px;width:100%;padding:10px;border-radius:10px">Exporter CSV '+yr+'</button></div>';}).join('');
  }
}

// ── DETAIL
function buildDGrid(a,cout){
  function inp(id,val,lbl,ph,field,isNum){
    var t=isNum?'number':'text';
    var s=isNum?' step="0.01"':'';
    var oc="saveField(this,'"+field+"'"+(isNum?",true":"")+")";
    return '<div class="dfield"><div class="dfield-lbl">'+lbl+'</div>'
      +'<input style="width:100%;background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:6px 8px;color:var(--text);font-family:inherit;font-size:13px;font-weight:600;margin-top:2px"'
      +' id="'+id+'" value="'+val+'" placeholder="'+ph+'" type="'+t+'"'+s
      +' onchange="'+oc+'"></div>';
  }
  function dateInp(id,val,lbl,field){
    var oc="saveField(this,'"+field+"')";
    return '<div class="dfield"><div class="dfield-lbl">'+lbl+'</div>'
      +'<input style="width:100%;background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:6px 8px;color:var(--text);font-family:inherit;font-size:13px;font-weight:600;margin-top:2px"'
      +' id="'+id+'" value="'+(val||'')+'" type="date" onchange="'+oc+'"></div>';
  }
  return inp('edit-marque',a.marque||'','Marque','Ex: New Balance','marque',false)
    +inp('edit-modele',a.modele||'','Modèle','Ex: 9060','modele',false)
    +inp('edit-taille',a.taille||'','Taille EU','Ex: 38','taille',false)
    +inp('edit-taillecm',a.tailleCm||'','Taille CM','Ex: 24.5','tailleCm',false)
    +inp('edit-couleur',a.couleur||'','Couleur','Ex: Blanc','couleur',false)
    +'<div class="dfield"><div class="dfield-lbl">Coût total</div><div class="dfield-val">'+fmtP(cout)+'</div></div>'
    +inp('edit-pvcible',a.pvcible||'','PV cible €','Ex: 90','pvcible',true)
    +dateInp('edit-date',a.date,'📅 Date achat','date')
    +dateInp('edit-dateRecu',a.dateRecu,'📦 Date réception','dateRecu')
    +dateInp('edit-dateMiseEnVente',a.dateMiseEnVente,'🏷️ Date mise en vente','dateMiseEnVente')
    +dateInp('edit-dateVente',a.dateVente,'✅ Date vente','dateVente');
}

function ouvrirNoteVendeur(){
  const form=document.getElementById('noteVendeurForm');
  if(form)form.style.display=form.style.display==='none'?'block':'none';
}
function sauveNoteVendeur(){
  const art=articles.find(a=>a.id===currentId);if(!art||!art.vendeur)return;
  const note=document.getElementById('detail-note-v').value;
  const comment=document.getElementById('detail-comment-v').value;
  ajouterOuMajVendeur(art.vendeur,note,comment,art.id);
  syncBlacklist();
  document.getElementById('noteVendeurForm').style.display='none';
  alert('✅ Note enregistrée !');
  openDetail(currentId);
}

// ── SYNC BLACKLIST CLOUDFLARE
async function syncBlacklist(){
  try{
    const vendeurs=getVendeurs();
    const blacklist=vendeurs.filter(v=>v.blacklist).map(v=>v.nom);
    await fetch('https://resell-proxy.tony-philippot.workers.dev',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'claude-sonnet-4-6',max_tokens:10,
        messages:[{role:'user',content:'ping'}],
        _blacklist:blacklist,_action:'sync_blacklist'
      })
    });
    localStorage.setItem('rt-blacklist-sync',JSON.stringify({blacklist,date:new Date().toISOString()}));
  }catch(e){}
}
async function loadSharedBlacklist(){
  try{
    const local=JSON.parse(localStorage.getItem('rt-blacklist-sync')||'{}');
    if(local.blacklist&&local.blacklist.length){
      const vendeurs=getVendeurs();
      let changed=false;
      local.blacklist.forEach(nom=>{
        const v=vendeurs.find(x=>x.nom.toLowerCase()===nom.toLowerCase());
        if(v&&!v.blacklist){v.blacklist=true;changed=true;}
        else if(!v){vendeurs.push({id:Date.now().toString()+Math.random(),nom,blacklist:true,achats:[],notes:[]});changed=true;}
      });
      if(changed){saveVendeurs(vendeurs);console.log('Blacklist sync appliquee');}
    }
  }catch(e){}
}

function saveField(el,field,isNum=false){
  const art=articles.find(a=>a.id===currentId);if(!art)return;
  art[field]=isNum?(parseFloat(el.value)||0):el.value;
  save();
}

// ⭐ Bouton étoile : marquer/démarquer comme "Top à racheter"
function toggleBest(){
  const art=articles.find(a=>a.id===currentId);if(!art)return;
  art.best=!art.best;
  save();
  document.getElementById('dNom').textContent=art.nom+(art.best?' ⭐':'');
  renderStock();renderDashboard();
  showToast(art.best?'⭐ Ajouté aux tops à racheter':'Retiré des tops');
}

// ✏️ Modifier le nom d'une paire (clic sur le titre dans la fiche)
function editArticleName(id){
  const art=articles.find(a=>a.id===id);if(!art)return;
  const nouveau=prompt('Modifier le nom de la paire :',art.nom||'');
  if(nouveau!==null&&nouveau.trim()!==''){
    art.nom=nouveau.trim();
    save();
    document.getElementById('dNom').textContent=art.nom+(art.best?' ':'');
    renderStock();renderVentes();renderDashboard();
    showToast('✅ Nom modifié');
  }
}

function openDetail(id){
  currentId=id;const a=articles.find(x=>x.id===id);if(!a)return;
  const photos=a.photos&&a.photos.length?a.photos:[];
  document.getElementById('dmainPhoto').innerHTML=coverPhoto(a)?'<img src="'+getPhotoURL(coverPhoto(a))+'">':`<span style="font-size:50px">${catEmoji(a.categorie)}</span>`;
  document.getElementById('dPhotos').innerHTML=photos.length?photos.map((p,i)=>{const url=getPhotoURL(p);const coverIdx=(a.coverIndex!==undefined)?a.coverIndex:(photos.length>1?1:0);return url?'<img src="'+url+'" class="'+(i===coverIdx?'main':'')+'" onclick="setMainPhotoByIndex('+i+',this)">':'';}).join(''):'';
  document.getElementById('dNom').textContent=a.nom+(a.best?' ':'');
  // ✏️ Rendre le nom éditable au clic
  const dNomEl=document.getElementById('dNom');
  dNomEl.style.cursor='pointer';
  dNomEl.title='Appuie pour modifier le nom';
  dNomEl.onclick=function(){editArticleName(a.id);};
  // 🗑️ Cacher le bouton "Partager" (inutile)
  document.querySelectorAll('[onclick*="shareArticleImage"]').forEach(b=>b.style.display='none');
  const j=ageStock(a);
  document.getElementById('dMeta').innerHTML=a.plateforme+' '+fmtDate(a.date)+' '+vintedTag(a.vinted);
  document.getElementById('dScore').innerHTML=scoreHtml(scoreRentabilite(a));
  document.getElementById('dAge').innerHTML=!['vendu','retour'].includes(a.statut)?'<span style="font-size:11px;color:'+ageColor(j)+'">En stock depuis '+j+' jour'+(j>1?'s':'')+'</span>':'';
  document.getElementById('dPvBasAlert').innerHTML=a.pvcible&&a.pvcible<prixMin(a.pa||0,a.port||0)?'<div class="pvbas-banner">PV trop bas ! Min : <b>'+fmtP(prixMin(a.pa||0,a.port||0))+'</b></div>':'';
  const cout=(a.pa||0)+(a.port||0);
  document.getElementById('dGrid').innerHTML=buildDGrid(a,cout);
  // Alerte blacklist dans detail
  if(a.vendeur && estBlackliste(a.vendeur)){
    document.getElementById('dPvBasAlert').innerHTML+='<div class="pvbas-banner" style="background:var(--red-bg);color:var(--red)">&#128683; Vendeur blackliste : '+a.vendeur+'</div>';
  }
  const pm=prixMin(a.pa||0,a.port||0);
  const pMinEl=document.getElementById('pMinBanner');if(pMinEl)pMinEl.innerHTML='<div class="pmin-banner">Prix minimum sans perte : <b>'+fmtP(pm)+'</b></div>';
  // Simulateurs supprimés - vérifier l'existence avant utilisation
  const slider=document.getElementById('simSlider');if(slider){slider.min=Math.floor(pm);slider.max=Math.ceil(pm*4);slider.value=a.pvcible||Math.ceil(pm*1.5);}
  const nslider=document.getElementById('negoSlider');if(nslider){nslider.min=Math.floor(pm*0.5);nslider.max=Math.ceil(pm*3);nslider.value=a.pvcible||Math.ceil(pm*1.2);}
  if(slider)updateSim();if(nslider)updateNego();
  const q=encodeURIComponent(((a.marque||'')+' '+(a.modele||a.nom)+' '+(a.taille||'')).trim());
  document.getElementById('dLinks').innerHTML='<a href="https://www.stockx.com/search?s='+q+'" class="plink" target="_blank">StockX</a><a href="https://www.farfetch.com/fr/shopping/search/?q='+q+'" class="plink" target="_blank">Farfetch</a><a href="https://www.vinted.fr/catalog?search_text='+q+'" class="plink" target="_blank">Vinted</a><a href="https://www.vestiairecollective.com/search/?q='+q+'" class="plink" target="_blank">Vestiaire</a>';
  document.getElementById('dPv').value=a.pv||'';document.getElementById('dVinted').value=a.vinted||'tony';
  document.getElementById('dCalc').innerHTML='';document.getElementById('dAiBox').innerHTML='';document.getElementById('dVintedDesc').innerHTML='';
  document.getElementById('dBtnVendu').style.display=a.statut==='vendu'?'none':'block';
  document.getElementById('dBtnRetour').style.display=a.statut==='vendu'?'block':'none';
  document.getElementById('dBtnRacheter').style.display=a.statut==='vendu'?'block':'none';
  if(a.statut==='vendu')updateDetailCalc();
  if(a.notes)document.getElementById('dCalc').innerHTML+='<div style="font-size:11px;color:var(--text2);margin-top:8px">'+a.notes+'</div>';
  // Section vendeur dans detail
  const vendeurBox=document.getElementById('dVendeurBox');
  if(vendeurBox){
    const vendeurs=getVendeurs();
    const vObj=a.vendeur?vendeurs.find(x=>x.nom.toLowerCase()===a.vendeur.toLowerCase()):null;
    const nm=vObj?notemoyenne(vObj):null;
    const stars=nm?'⭐'.repeat(Math.round(nm)):'-';
    vendeurBox.innerHTML=a.vendeur?
      '<div style="background:var(--card2);border-radius:10px;padding:10px 12px;margin-top:8px">'
      +'<div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px">Vendeur</div>'
      +'<div style="display:flex;justify-content:space-between;align-items:center">'
      +'<div><div style="font-size:13px;font-weight:600">'+(vObj&&vObj.blacklist?'🚫 ':'')+a.vendeur+'</div>'
      +(nm?'<div style="font-size:12px;color:var(--amber)">'+stars+' ('+nm.toFixed(1)+'/5)</div>':'')
      +'</div>'
      +'<button class="bsmall p" onclick="ouvrirNoteVendeur()" style="font-size:11px">✏️ Noter</button>'
      +'</div>'
      +'<div id="noteVendeurForm" style="display:none;margin-top:8px">'
      +'<div class="frow"><select id="detail-note-v" style="background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:8px;color:var(--text);font-family:inherit;width:100%"><option value="5">⭐⭐⭐⭐⭐ Excellent</option><option value="4">⭐⭐⭐⭐ Bien</option><option value="3">⭐⭐⭐ Moyen</option><option value="2">⭐⭐ Mauvais</option><option value="1">⭐ Très mauvais</option></select>'
      +'<input id="detail-comment-v" type="text" placeholder="Commentaire" style="background:var(--card);border:1px solid var(--border2);border-radius:8px;padding:8px;color:var(--text);font-family:inherit;width:100%"></div>'
      +'<button class="bsmall g" onclick="sauveNoteVendeur()" style="width:100%;padding:8px;margin-top:6px;border-radius:8px">Enregistrer la note</button>'
      +'</div>'
      +'</div>'
      :'';
  }
  openM('mDetail');
  // 🗑️ Cacher le champ "Date de vente" en double (section Marquer vendu)
  setTimeout(()=>{
    const dv=document.getElementById('dDateVente');
    if(dv){
      dv.style.display='none';
      // Cacher tout label "DATE DE VENTE" frère ou proche
      const modal=document.querySelector('#mDetail .modal');
      if(modal){
        modal.querySelectorAll('*').forEach(el=>{
          const t=(el.childNodes.length===1&&el.childNodes[0].nodeType===3)?el.textContent.trim():'';
          if(/^date de vente$/i.test(t))el.style.display='none';
        });
      }
    }
  },50);
  // 🔧 Anti-débordement horizontal : corriger tout élément trop large dans la fiche
  setTimeout(()=>{
    const modal=document.querySelector('#mDetail .modal');
    if(!modal)return;
    const maxW=modal.clientWidth;
    let coupable='';
    modal.querySelectorAll('*').forEach(el=>{
      if(el.scrollWidth>maxW+2 && !el.classList.contains('dphotos') && el.id!=='dPhotos'){
        if(!coupable)coupable=(el.id||el.className||el.tagName);
        el.style.maxWidth='100%';
        el.style.overflowX='hidden';
        el.style.overflowWrap='break-word';
      }
    });
    // Décommenter pour debug : if(coupable)showToast('Débordement: '+coupable);
  },120);
}
function setMainPhoto(el,src){
  document.getElementById('dmainPhoto').innerHTML='<img src="'+src+'">';
  document.querySelectorAll('#dPhotos img').forEach(i=>i.classList.remove('main'));
  el.classList.add('main');
}
// 📌 Définir la photo principale par son index (fiable + mémorisé)
function setMainPhotoByIndex(idx,el){
  const art=articles.find(a=>a.id===currentId);
  if(!art||!art.photos||!art.photos[idx])return;
  art.coverIndex=idx;
  save();
  const url=getPhotoURL(art.photos[idx]);
  document.getElementById('dmainPhoto').innerHTML='<img src="'+url+'">';
  document.querySelectorAll('#dPhotos img').forEach(i=>i.classList.remove('main'));
  if(el)el.classList.add('main');
  renderStock();renderVentes();renderDashboard();
  showToast('📌 Photo principale définie');
}
function updateSim(){const slider=document.getElementById('simSlider');if(!slider)return;const art=articles.find(a=>a.id===currentId);if(!art)return;const pv=parseInt(slider.value);const valEl=document.getElementById('simVal');if(valEl)valEl.textContent=pv+' \u20ac';const r=calcEst(art.pa||0,art.port||0,pv);if(!r)return;const resEl=document.getElementById('simResult');if(resEl)resEl.innerHTML='<div class="cbox"><div class="crow"><span>Cout</span><span>-'+fmtP(r.cout)+'</span></div><div class="crow tot"><span>Marge nette</span><span style="color:'+(r.net>=0?'var(--green)':'var(--red)')+'">'+fmt(r.net)+'</span></div><div class="crow"><span>ROI</span><span>'+r.roi.toFixed(1)+'%</span></div></div>';}
function updateNego(){const slider=document.getElementById('negoSlider');if(!slider)return;const art=articles.find(a=>a.id===currentId);if(!art)return;const pv=parseInt(slider.value);const pm=prixMin(art.pa||0,art.port||0);const valEl=document.getElementById('negoVal');if(valEl)valEl.textContent=pv+' \u20ac';const r=calcEst(art.pa||0,art.port||0,pv);const ok=pv>=pm;const resEl=document.getElementById('negoResult');if(resEl)resEl.innerHTML='<div class="crow"><span>Marge si accepte</span><span style="color:'+(ok?'var(--green)':'var(--red)')+'">'+(r?fmt(r.net):'--')+'</span></div><div style="margin-top:6px;padding:8px;border-radius:8px;background:'+(ok?'var(--green-bg)':'var(--red-bg)')+';font-size:12px;font-weight:600;color:'+(ok?'var(--green)':'var(--red)')+'">'+(ok?'OK Accepter - tu restes gagnant':'Non Refuser - en dessous du minimum')+'</div>';}
function updateDetailCalc(){const art=articles.find(a=>a.id===currentId);if(!art)return;const pv=parseFloat(document.getElementById('dPv').value)||0;if(!pv)return;const cout=(art.pa||0)+(art.port||0);const net=pv-cout;const roi=cout>0?net/cout*100:0;document.getElementById('dCalc').innerHTML='<div class="cbox"><div class="crow"><span>Cout total (PA+port)</span><span>'+fmtP(cout)+'</span></div><div class="crow"><span>Prix de vente</span><span>'+fmtP(pv)+'</span></div><div class="crow tot"><span>Marge nette</span><span style="color:'+(net>=0?'var(--green)':'var(--red)')+'">'+fmt(net)+'</span></div><div class="crow"><span>ROI</span><span>'+roi.toFixed(1)+'%</span></div></div>';}

// ── IA
async function aiEstimate(){
  const art=articles.find(a=>a.id===currentId);if(!art)return;
  const box=document.getElementById('dAiBox');
  box.innerHTML='<div class="aibox"><div class="aibox-title"><span class="spin"></span>Analyse IA en cours...</div></div>';
  try{
    const resp=await fetch('https://resell-proxy.tony-philippot.workers.dev',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens:400,
        messages:[{role:'user',content:'Expert revente mode. Estime prix de revente pour: '+art.nom+'. Marque: '+(art.marque||'?')+'. Modele: '+(art.modele||'?')+'. Taille: '+(art.taille||'?')+'. Couleur: '+(art.couleur||'?')+'. PA: '+(art.pa||0)+'euros. Reponds UNIQUEMENT en JSON valide sans backticks: {"vinted_min":nombre,"vinted_max":nombre,"stockx_min":nombre,"stockx_max":nombre,"conseil":"courte phrase","tendance":"hausse ou stable ou baisse"}'}]
      })
    });
    if(!resp.ok){throw new Error('HTTP '+resp.status);}
    const data=await resp.json();
    if(data.error){throw new Error(JSON.stringify(data.error));}
    const txt=data.content[0].text.replace(/```json|```/g,'').trim();
    const r=JSON.parse(txt);
    const trend=r.tendance==='hausse'?'En hausse':r.tendance==='baisse'?'En baisse':'Stable';
    box.innerHTML='<div class="aibox"><div class="aibox-title">Estimation IA</div><div class="aibox-body"><b style="color:var(--green)">Vinted:</b> '+r.vinted_min+'€-'+r.vinted_max+'€<br><b style="color:var(--blue)">StockX:</b> '+r.stockx_min+'€-'+r.stockx_max+'€<br><b>Tendance:</b> '+trend+'<br><span style="color:var(--text2)">'+r.conseil+'</span></div></div>';
  }catch(err){
    console.error('aiEstimate error:',err);
    box.innerHTML='<div class="aibox"><div class="aibox-body" style="color:var(--red);font-size:12px">Erreur: '+err.message+'</div></div>';
  }
}
async function genVintedDesc(){
  const art=articles.find(a=>a.id===currentId);if(!art)return;
  const box=document.getElementById('dVintedDesc');
  box.innerHTML='<div class="cbox" style="margin-top:8px"><span class="spin"></span>Generation en cours...</div>';
  try{
    const resp=await fetch('https://resell-proxy.tony-philippot.workers.dev',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens:400,
        messages:[{role:'user',content:'Tu es un particulier français qui vend sur Vinted. Ecris une annonce courte et naturelle, style vrai particulier, pas trop pro. La paire est NEUVE AVEC ETIQUETTE, jamais portée. IMPORTANT : si tu mentionnes pourquoi tu vends, dis TOUJOURS que la paire a été REÇUE EN CADEAU (jamais "achetée" ou "j\'ai acheté"). Inclus la couleur et la taille EU et CM. Format: titre court (8 mots max) puis 3-4 lignes. Article: '+art.nom+'. Marque: '+(art.marque||'')+'. Modele: '+(art.modele||'')+'. Taille EU: '+(art.taille||'')+'. Taille CM: '+(art.tailleCm||'')+'. Couleur: '+(art.couleur||'')+'. Notes: '+(art.notes||'')+'. IMPORTANT: mentionne la taille EU ET les CM dans lannonce. Termine TOUJOURS par ces deux lignes: Neuve avec étiquette, jamais portée. puis saut de ligne puis le message boite selon letat: si parfaite ecris: 📦 Envoi soigné dans un sac dexpédition. Boîte en parfait état. si marques ecris: 📦 Envoi soigné dans un sac dexpédition. La boîte peut avoir de légères marques liées au transport, mais la paire est bien protégée. si sans ecris: 📦 Envoi soigné dans un sac dexpédition. Vendu sans boîte. Etat boite: '+(art.boite||'marques')+'.  Reponds uniquement avec le texte, sans guillemets.'}]
      })
    });
    if(!resp.ok){throw new Error('HTTP '+resp.status);}
    const data=await resp.json();
    if(data.error){throw new Error(JSON.stringify(data.error));}
    if(!data.content||!data.content[0]){throw new Error('Reponse vide');}
    const txt=data.content[0].text;
    box.innerHTML='<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;margin-bottom:4px"><span style="font-size:11px;color:var(--text2)">Annonce generee</span><button class="bsmall" onclick="copyDesc()">Copier</button></div><div class="vdesc" id="vintedDescText">'+txt+'</div>';
  }catch(err){
    console.error('genVintedDesc error:',err);
    box.innerHTML='<div class="cbox" style="margin-top:8px;color:var(--red);font-size:12px">Erreur: '+err.message+'</div>';
  }
}
function copyDesc(){const t=document.getElementById('vintedDescText');if(t)navigator.clipboard.writeText(t.textContent).then(()=>alert('Copie !'));}

// ── IMPRESSION
function shareArticleImage(){
  const a=articles.find(x=>x.id===currentId);if(!a)return;
  const r=calcMarge(a);const pm=prixMin(a.pa||0,a.port||0);
  const canvas=document.createElement('canvas');
  canvas.width=600;canvas.height=700;
  const ctx=canvas.getContext('2d');
  // Background
  ctx.fillStyle='#1a1a2e';ctx.fillRect(0,0,600,700);
  // Header band
  ctx.fillStyle='#1fd99a';ctx.fillRect(0,0,600,8);
  // Photo
  const drawText=()=>{
    ctx.fillStyle='#f0f0f8';ctx.font='bold 26px sans-serif';
    const nom=a.nom+(a.best?' ⭐':'');
    ctx.fillText(nom.length>30?nom.slice(0,30)+'…':nom,30,80);
    ctx.fillStyle='#8888aa';ctx.font='14px sans-serif';
    ctx.fillText([a.marque,a.modele].filter(Boolean).join(' — ')||a.plateforme,30,108);
    ctx.fillText([a.taille?'EU '+a.taille:'',a.tailleCm?a.tailleCm+' cm':'',a.couleur].filter(Boolean).join(' · '),30,130);
    // Separator
    ctx.strokeStyle='rgba(255,255,255,0.1)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(30,150);ctx.lineTo(570,150);ctx.stroke();
    // Stats
    const stats=[['PA + Port',a.pa||0+'€'],['PV cible',(a.pvcible||0)+'€'],['Marge min',(a.pv?fmt(r.net):'—')],['Prix min',fmtP(pm)]];
    stats.forEach(([lbl,val],i)=>{const x=i%2===0?30:310;const y=180+Math.floor(i/2)*70;ctx.fillStyle='#22223a';ctx.beginPath();ctx.roundRect(x,y,250,55,10);ctx.fill();ctx.fillStyle='#8888aa';ctx.font='11px sans-serif';ctx.fillText(lbl.toUpperCase(),x+15,y+20);ctx.fillStyle='#f0f0f8';ctx.font='bold 20px sans-serif';ctx.fillText(val,x+15,y+42);});
    // Statut badge
    const colors={stock:'#4d9fff',vente:'#ffb547',vendu:'#1fd99a',attente:'#a78bfa',retour:'#ff5566'};
    ctx.fillStyle=colors[a.statut]||'#888';ctx.beginPath();ctx.roundRect(30,340,120,32,16);ctx.fill();
    ctx.fillStyle='#000';ctx.font='bold 13px sans-serif';ctx.fillText(statLabel(a.statut),55,361);
    // Footer
    ctx.fillStyle='#8888aa';ctx.font='11px sans-serif';ctx.fillText('ResellTracker — '+fmtDate(a.date),30,680);
    ctx.fillText(a.plateforme+(a.vinted?' · '+(a.vinted==='tony'?'Tony 💙':'Laetitia 💗'):''),400,680);
  };
  if(a.photos&&a.photos[0]&&getPhotoURL(a.photos[0])){
    const img=new Image();
    img.onload=()=>{
      ctx.save();ctx.beginPath();ctx.roundRect(30,20,100,100,12);ctx.clip();
      ctx.drawImage(img,30,20,100,100);ctx.restore();
      drawText();shareCanvas(canvas,a.nom);
    };
    img.src=getPhotoURL(a.photos[0]);
  }else{drawText();shareCanvas(canvas,a.nom);}
}
function shareCanvas(canvas,nom){
  canvas.toBlob(blob=>{
    if(!blob){showToast('❌ Erreur génération image');return;}
    const file=new File([blob],'reselltracker-'+nom.replace(/\s+/g,'-')+'.png',{type:'image/png'});
    if(navigator.share&&navigator.canShare&&navigator.canShare({files:[file]})){
      navigator.share({files:[file],title:nom}).catch(e=>{
        // L'utilisateur a annulé OU erreur : fallback téléchargement
        if(e.name!=='AbortError'){
          const url=URL.createObjectURL(blob);
          const a=document.createElement('a');a.href=url;a.download='reselltracker-'+nom+'.png';a.click();
          showToast('📥 Image téléchargée');
        }
      });
    }else{
      const url=URL.createObjectURL(blob);
      const a=document.createElement('a');a.href=url;a.download='reselltracker-'+nom+'.png';a.click();
      showToast('📥 Image téléchargée');
    }
  },'image/png');
}

function printFiche(){const a=articles.find(x=>x.id===currentId);if(!a)return;const r=calcMarge(a);const pm=prixMin(a.pa||0,a.port||0);document.getElementById('printSheet').innerHTML='<div style="max-width:420px;margin:0 auto;font-family:sans-serif"><h2>'+a.nom+'</h2><p style="color:#666;font-size:13px;margin-bottom:16px">'+a.plateforme+' '+fmtDate(a.date)+(a.vinted?' '+a.vinted:'')+'</p>'+(a.photos&&a.photos[0]&&getPhotoURL(a.photos[0])?'<img src="'+getPhotoURL(a.photos[0])+'" style="width:100%;max-height:220px;object-fit:cover;border-radius:8px;margin-bottom:16px">':'')+'<table style="width:100%;border-collapse:collapse;font-size:14px"><tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #eee">Marque</td><td style="text-align:right;border-bottom:1px solid #eee">'+(a.marque||'--')+'</td></tr><tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #eee">Modele</td><td style="text-align:right;border-bottom:1px solid #eee">'+(a.modele||'--')+'</td></tr><tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #eee">Taille</td><td style="text-align:right;border-bottom:1px solid #eee">'+(a.taille||'--')+'</td></tr><tr><td style="padding:6px 0;color:#666;border-bottom:1px solid #eee">Couleur</td><td style="text-align:right;border-bottom:1px solid #eee">'+(a.couleur||'--')+'</td></tr><tr><td style="padding:6px 0;color:#E24B4A">Min sans perte</td><td style="text-align:right;font-weight:600;color:#E24B4A">'+fmtP(pm)+'</td></tr>'+(r?'<tr><td style="padding:6px 0;font-weight:600">Marge nette</td><td style="text-align:right;font-weight:600;color:'+(r.net>=0?'#1D9E75':'#E24B4A')+'">'+fmt(r.net)+'</td></tr>':'')+'</table>'+(a.notes?'<p style="margin-top:12px;font-size:13px;color:#666">'+a.notes+'</p>':'')+'<p style="margin-top:16px;font-size:11px;color:#aaa">ResellTracker '+new Date().toLocaleDateString('fr-FR')+'</p></div>';window.print();}

// ── TRACKING
const TRK_STEPS=['En preparation','Conditionnement','En transit','En livraison','Livre'];
function openTrkModal(){['trk-nom','trk-num','trk-eta'].forEach(id=>document.getElementById(id).value='');document.getElementById('trk-date').value=new Date().toISOString().split('T')[0];openM('mTrk');}
function saveTrk(){const num=document.getElementById('trk-num').value.trim();if(!num){alert('Entrez un numero');return;}tracking.push({id:Date.now().toString(),nom:document.getElementById('trk-nom').value||'Colis',num,carrier:document.getElementById('trk-carrier').value,date:document.getElementById('trk-date').value,step:parseInt(document.getElementById('trk-stat').value),eta:document.getElementById('trk-eta').value});save();closeM('mTrk');renderTracking();}
function updateTrkStep(id,step){const t=tracking.find(x=>x.id===id);if(!t)return;t.step=parseInt(step);save();renderTracking();}
function suppTrk(id){if(!confirm('Supprimer ?'))return;tracking=tracking.filter(x=>x.id!==id);save();renderTracking();}
function renderTracking(){const list=document.getElementById('trackingList');if(!tracking.length){list.innerHTML='<div class="empty"><div class="eicon">&#128230;</div>Aucun colis</div>';return;}list.innerHTML=[...tracking.filter(t=>t.step<4),...tracking.filter(t=>t.step>=4)].map(t=>'<div class="trow"><div style="font-size:22px">'+(t.step>=4?'OK':t.step>=3?'camion':t.step>=2?'avion':t.step>=1?'boite':'usine')+'</div><div class="tinfo"><div class="tnom">'+t.nom+'</div><div class="tnum">'+t.num+' '+t.carrier+'</div>'+(t.eta?'<div style="font-size:11px;color:var(--text2)">Livraison: '+t.eta+'</div>':'')+'<div class="delivery-bar">'+TRK_STEPS.map((s,i)=>'<div class="db-step '+(i<t.step?'done':i===t.step?'current':'')+'"><div class="db-dot">'+(i<t.step?'v':'')+'</div><div class="db-lbl">'+s+'</div></div>').join('')+'</div></div></div><div style="display:flex;gap:6px;margin:-4px 0 10px;padding:0 4px"><select onchange="updateTrkStep(\''+t.id+'\',this.value)" style="flex:1;font-size:12px;background:var(--card2);border:1px solid var(--border2);border-radius:8px;padding:6px 8px;color:var(--text);font-family:inherit">'+TRK_STEPS.map((s,i)=>'<option value="'+i+'" '+(t.step===i?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="bsmall" onclick="suppTrk(\''+t.id+'\')">Suppr</button></div>').join('');}

// ── CALENDRIER
function calPrev(){calMonth--;if(calMonth<0){calMonth=11;calYear--;}renderCalendar();}
function calNext(){calMonth++;if(calMonth>11){calMonth=0;calYear++;}renderCalendar();}
function renderCalendar(){
  const mn=['Janvier','F\u00e9vrier','Mars','Avril','Mai','Juin','Juillet','Ao\u00fbt','Septembre','Octobre','Novembre','D\u00e9cembre'];
  document.getElementById('calTitle').textContent=mn[calMonth]+' '+calYear;
  const today=new Date();const first=new Date(calYear,calMonth,1);let dow=(first.getDay()+6)%7;
  const dim=new Date(calYear,calMonth+1,0).getDate();const events={};
  const ym=calYear+'-'+String(calMonth+1).padStart(2,'0');
  articles.forEach(a=>{if(a.date&&a.date.startsWith(ym)){const d=parseInt(a.date.split('-')[2]);if(!events[d])events[d]=[];events[d].push({type:'achat',color:'var(--blue)',nom:a.nom,id:a.id});}if(a.dateVente&&a.dateVente.startsWith(ym)){const d=parseInt(a.dateVente.split('-')[2]);if(!events[d])events[d]=[];events[d].push({type:'vente',color:'var(--green)',nom:a.nom,id:a.id});}});
  let html='';for(let i=0;i<dow;i++)html+='<div class="cal-day other-month"></div>';
  for(let d=1;d<=dim;d++){const isToday=d===today.getDate()&&calMonth===today.getMonth()&&calYear===today.getFullYear();const evs=events[d]||[];html+='<div class="cal-day'+(isToday?' today':'')+'" onclick="showCalDay('+d+')"><div class="cal-num">'+d+'</div>'+evs.slice(0,3).map(e=>'<div class="cal-dot" style="background:'+e.color+'"></div>').join('')+'</div>';}
  document.getElementById('calGrid').innerHTML=html;showCalDay(today.getDate());
}
function showCalDay(d){const key=calYear+'-'+String(calMonth+1).padStart(2,'0')+'-'+String(d).padStart(2,'0');const arts=articles.filter(a=>a.date===key||a.dateVente===key);document.getElementById('calEventsTitle').textContent=d+'/'+(calMonth+1)+'/'+calYear;document.getElementById('calEvents').innerHTML=!arts.length?'<div style="font-size:12px;color:var(--text2)">Aucun evenement</div>':arts.map(a=>'<div class="irow" onclick="openDetail(\''+a.id+'\')"><div class="ithumb">'+thumb(a)+'</div><div class="iinfo"><div class="iname">'+a.nom+'</div><div class="imeta">'+(a.dateVente===key?'Vendu':'Achete')+' '+fmtP(a.dateVente===key?a.pv||0:a.pa||0)+'</div></div></div>').join('');}

// ── PAIEMENTS
function switchPay(t){payTab=t;document.querySelectorAll('#screen-paiements .ts').forEach((el,i)=>el.classList.toggle('on',['attente','recu'][i]===t));renderPaiements();}
function renderPaiements(){
  const pays=JSON.parse(localStorage.getItem('rt-pay')||'[]');const list=document.getElementById('paiementsList');
  const filtered=payTab==='attente'?pays.filter(p=>!p.recu):pays.filter(p=>p.recu);
  const tA=pays.filter(p=>!p.recu).reduce((s,p)=>s+p.montant,0);const tR=pays.filter(p=>p.recu).reduce((s,p)=>s+p.montant,0);
  document.getElementById('payStats').innerHTML='<div class="kpi-grid"><div class="kpi-card"><div class="kpi-lbl">En attente</div><div class="kpi-val kv-a">'+fmtP(tA)+'</div></div><div class="kpi-card"><div class="kpi-lbl">Recu total</div><div class="kpi-val kv-g">'+fmtP(tR)+'</div></div></div>';
  if(!filtered.length){list.innerHTML='<div class="empty"><div class="eicon">&#128179;</div>Aucun paiement</div>';return;}
  list.innerHTML=filtered.sort((a,b)=>b.date.localeCompare(a.date)).map(p=>'<div class="pay-row"><div style="flex:1"><div class="pay-nom">'+p.nom+'</div><div class="pay-meta">'+vintedTag(p.vinted)+' '+fmtDate(p.date)+'</div></div><div style="text-align:right"><div class="pay-amount'+(p.recu?' recu':'')+'">'+fmtP(p.montant)+'</div>'+(!p.recu?'<button class="bsmall g" style="margin-top:4px;font-size:10px;padding:4px 8px" onclick="marquerPayRecu(\''+p.id+'\')">Recu</button>':'')+'</div></div>').join('');
}
function marquerPayRecu(id){const pays=JSON.parse(localStorage.getItem('rt-pay')||'[]');const p=pays.find(x=>x.id===id);if(!p)return;p.recu=true;p.dateRecu=new Date().toISOString().split('T')[0];localStorage.setItem('rt-pay',JSON.stringify(pays));renderPaiements();}

// ── EXPORT CSV
function backupData(){
  const data={articles,futurs,tracking,pays:JSON.parse(localStorage.getItem('rt-pay')||'[]'),objectif,date:new Date().toISOString()};
  const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
  const url=URL.createObjectURL(blob);
  const el=document.createElement('a');el.href=url;
  el.download='reselltracker-backup-'+new Date().toISOString().split('T')[0]+'.json';
  el.click();
  alert('Sauvegarde téléchargée ! Mets-la sur Google Drive pour la garder en sécurité.');
}
function restoreData(){
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';
  input.onchange=e=>{
    const file=e.target.files[0];if(!file)return;
    const reader=new FileReader();
    reader.onload=ev=>{
      try{
        const data=JSON.parse(ev.target.result);
        const dateStr=data.date?new Date(data.date).toLocaleDateString('fr-FR'):'inconnue';
        if(!confirm('Restaurer la sauvegarde du '+dateStr+' ?\n('+(data.articles?data.articles.length:0)+' articles)\nTes données actuelles seront remplacées.'))return;
        if(data.articles)articles=data.articles;
        if(data.futurs)futurs=data.futurs;
        if(data.tracking)tracking=data.tracking;
        if(data.pays)localStorage.setItem('rt-pay',JSON.stringify(data.pays));
        if(data.vendeurs)localStorage.setItem('rt-vendeurs',JSON.stringify(data.vendeurs));
        if(data.objectif!==undefined){objectif=data.objectif;localStorage.setItem('rt-obj',objectif);}
        save();
        renderDashboard();renderStock();renderVentes();renderFuturs();
        closeM('mSettings');
        alert('✅ '+(data.articles?data.articles.length:0)+' articles restaurés ! Va sur Stock pour les voir.');
      }catch(e){alert('Fichier invalide : '+e.message);}
    };
    reader.readAsText(file);
  };
  input.click();
}

function exportCSV(year){const arts=articles.filter(a=>a.statut==='vendu'&&a.dateVente&&a.dateVente.startsWith(year));let csv='Date;Nom;Marque;Modele;Taille;Couleur;Plateforme;Vinted;PA;Port;Cout;PV;Frais Vinted;Port Vente;Marge;ROI\n';arts.forEach(a=>{const r=calcMarge(a);csv+=[a.dateVente,a.nom,a.marque||'',a.modele||'',a.taille||'',a.couleur||'',a.plateforme,a.vinted||'',a.pa||0,a.port||0,(a.pa||0)+(a.port||0),a.pv||0,r?r.fraisV.toFixed(2):0,a.portVente||0,r?r.net.toFixed(2):0,r?r.roi.toFixed(1):0].join(';')+'\n';});const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const url=URL.createObjectURL(blob);const el=document.createElement('a');el.href=url;el.download='reselltracker_'+year+'.csv';el.click();}

// ── NOTIFICATIONS PUSH
async function requestNotifPermission(){
  if(!('Notification' in window)){alert('Notifications non supportées sur ce navigateur.');return;}
  const perm=await Notification.requestPermission();
  if(perm==='granted'){
    localStorage.setItem('rt-notif','1');
    alert('✅ Notifications activées ! Tu recevras des rappels pour tes articles en stock.');
  }else{
    alert('Notifications refusées. Tu peux les activer dans les réglages.');
  }
}
function checkNotifications(){
  if(localStorage.getItem('rt-notif')!=='1')return;
  if(Notification.permission!=='granted')return;
  const vieux=articles.filter(a=>['stock','vente'].includes(a.statut)&&a.date&&ageJours(a.date)>7);
  if(vieux.length>0){
    new Notification('ResellTracker 📦',{body:vieux.length+' article'+(vieux.length>1?'s':'')+' en stock depuis plus de 7 jours !',icon:'/manifest.json'});
  }
}
// Check notifications au démarrage (une fois par jour)
const lastCheck=localStorage.getItem('rt-lastcheck')||'';
const today2=new Date().toISOString().split('T')[0];
if(lastCheck!==today2){localStorage.setItem('rt-lastcheck',today2);setTimeout(checkNotifications,3000);}

// ── VENDEURS
function getVendeurs(){return JSON.parse(localStorage.getItem('rt-vendeurs')||'[]');}
function saveVendeurs(v){localStorage.setItem('rt-vendeurs',JSON.stringify(v));}

function ajouterOuMajVendeur(nom,note,commentaire,artId){
  if(!nom||!nom.trim())return;
  nom=nom.trim();
  const vendeurs=getVendeurs();
  let v=vendeurs.find(x=>x.nom.toLowerCase()===nom.toLowerCase());
  if(!v){
    v={id:Date.now().toString(),nom,blacklist:false,achats:[],notes:[]};
    vendeurs.push(v);
  }
  if(artId&&!v.achats.includes(artId))v.achats.push(artId);
  if(note){v.notes.push({note:parseInt(note),commentaire:commentaire||'',date:new Date().toISOString().split('T')[0],artId});}
  saveVendeurs(vendeurs);
  return v;
}

function notemoyenne(v){
  if(!v.notes||!v.notes.length)return null;
  return v.notes.reduce((s,n)=>s+n.note,0)/v.notes.length;
}

function estBlackliste(nom){
  if(!nom)return false;
  const vendeurs=getVendeurs();
  const v=vendeurs.find(x=>x.nom.toLowerCase()===nom.toLowerCase());
  return v&&v.blacklist;
}

function toggleBlacklist(id){
  const vendeurs=getVendeurs();
  const v=vendeurs.find(x=>x.id===id);
  if(!v)return;
  v.blacklist=!v.blacklist;
  saveVendeurs(vendeurs);
  renderVendeurs();
}

function renderVendeurs(){
  const vendeurs=getVendeurs().sort((a,b)=>{
    const na=notemoyenne(a)||0,nb=notemoyenne(b)||0;
    return nb-na;
  });
  const list=document.getElementById('vendeursList');
  if(!vendeurs.length){
    list.innerHTML='<div class="empty"><div class="eicon">&#128100;</div>Aucun vendeur enregistre</div>';
    return;
  }
  list.innerHTML=vendeurs.map(v=>{
    const nm=notemoyenne(v);
    const stars=nm?'&#9733;'.repeat(Math.round(nm))+'&#9734;'.repeat(5-Math.round(nm)):'Non note';
    const starsColor=nm>=4?'var(--green)':nm>=3?'var(--amber)':nm?'var(--red)':'var(--text2)';
    return '<div class="card2" style="'+(v.blacklist?'border-color:var(--red);':'')+'">'
      +'<div style="display:flex;justify-content:space-between;align-items:center">'
      +'<div><div style="font-size:14px;font-weight:600">'+(v.blacklist?'&#128683; ':'')+v.nom+'</div>'
      +'<div style="font-size:13px;color:'+starsColor+';margin-top:2px">'+stars+(nm?' ('+nm.toFixed(1)+'/5)':'')+'</div>'
      +'<div style="font-size:11px;color:var(--text2);margin-top:2px">'+v.achats.length+' achat'+(v.achats.length>1?'s':'')+'</div>'
      +'</div>'
      +'<div style="display:flex;gap:6px">'
      +'<button class="bsmall '+(v.blacklist?'g':'r')+'" style="font-size:11px" onclick="toggleBlacklist(\''+v.id+'\')">'+( v.blacklist?'Retirer':'Blacklister')+'</button>'
      +'</div></div>'
      +(v.notes.length?'<div style="margin-top:8px">'+v.notes.slice(-3).reverse().map(n=>'<div style="font-size:11px;color:var(--text2);padding:3px 0;border-bottom:1px solid var(--border)">'+
        '&#9733;'.repeat(n.note)+' '+n.date+(n.commentaire?' — '+n.commentaire:'')+'</div>').join('')+'</div>':'')
      +'</div>';
  }).join('');
}

// ── PRIX DU MARCHÉ
function renderMarche(){
  const list=document.getElementById('marcheStock');
  const arts=articles.filter(a=>!['vendu','retour'].includes(a.statut)).slice(0,5);
  list.innerHTML=!arts.length?'<div style="font-size:12px;color:var(--text2)">Ajoute des articles à ton stock pour voir des suggestions ici.</div>':
    arts.map(a=>`<div class="irow" onclick="rechercheArticle('${a.id}')"><div class="ithumb">${thumb(a)}</div><div class="iinfo"><div class="iname">${a.nom}</div><div class="imeta">${[a.marque,a.taille].filter(Boolean).join(' · ')}</div></div><div class="ival"><button class="bsmall p" style="font-size:11px;padding:5px 8px">💹</button></div></div>`).join('');
}
function rechercheArticle(id){
  const a=articles.find(x=>x.id===id);if(!a)return;
  document.getElementById('marcheSearch').value=[a.marque,a.modele||a.nom,a.taille].filter(Boolean).join(' ');
  rechercheMarche();
}
async function rechercheMarche(){
  const q=document.getElementById('marcheSearch').value.trim();
  if(!q){alert('Entre un article à rechercher');return;}
  const box=document.getElementById('marcheResult');
  box.innerHTML='<div class="cbox"><span class="spin"></span> Recherche en cours...</div>';
  try{
    const resp=await fetch('https://resell-proxy.tony-philippot.workers.dev',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:500,
        messages:[{role:'user',content:'Tu es un expert de la revente de sneakers et vêtements sur Vinted en France. Pour larticle "'+q+'" neuf avec etiquette, donne une estimation realiste des prix actuels sur Vinted. Reponds UNIQUEMENT en JSON sans backticks: {"prix_bas":nombre,"prix_moyen":nombre,"prix_haut":nombre,"tendance":"hausse|stable|baisse","conseil":"1 phrase conseil pratique","popularite":"faible|moyenne|forte","temps_vente_estime":"ex: 3-7 jours"}'}]})
    });
    const data=await resp.json();
    if(data.error)throw new Error(JSON.stringify(data.error));
    const r=JSON.parse(data.content[0].text.replace(/```json|```/g,'').trim());
    const trendIcon=r.tendance==='hausse'?'📈':r.tendance==='baisse'?'📉':'➡️';
    const popColor=r.popularite==='forte'?'var(--green)':r.popularite==='moyenne'?'var(--amber)':'var(--text2)';
    box.innerHTML=`<div class="marche-result">
      <div style="font-size:13px;font-weight:600;margin-bottom:10px">💹 ${q}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:10px">
        <div style="background:var(--card);border-radius:8px;padding:8px;text-align:center"><div style="font-size:9px;color:var(--text2)">BAS</div><div style="font-size:16px;font-weight:700;color:var(--text)">${r.prix_bas}€</div></div>
        <div style="background:var(--amber-bg);border:1px solid rgba(255,181,71,0.3);border-radius:8px;padding:8px;text-align:center"><div style="font-size:9px;color:var(--amber)">MOYEN</div><div style="font-size:16px;font-weight:700;color:var(--amber)">${r.prix_moyen}€</div></div>
        <div style="background:var(--card);border-radius:8px;padding:8px;text-align:center"><div style="font-size:9px;color:var(--text2)">HAUT</div><div style="font-size:16px;font-weight:700;color:var(--text)">${r.prix_haut}€</div></div>
      </div>
      <div style="font-size:12px;margin-bottom:5px">${trendIcon} Tendance : <b>${r.tendance}</b> · Popularité : <b style="color:${popColor}">${r.popularite}</b></div>
      <div style="font-size:12px;margin-bottom:5px">⏱️ Temps de vente estimé : <b>${r.temps_vente_estime}</b></div>
      <div style="font-size:12px;color:var(--text2);margin-top:8px;padding:8px;background:var(--card);border-radius:8px">${r.conseil}</div>
      <a href="https://www.vinted.fr/catalog?search_text=${encodeURIComponent(q)}" target="_blank" class="bsec" style="display:block;text-align:center;text-decoration:none;margin-top:8px;padding:10px">🔗 Voir sur Vinted</a>
    </div>`;
  }catch(err){box.innerHTML=`<div class="cbox" style="color:var(--red);font-size:12px">Erreur: ${err.message}</div>`;}
}

loadSharedBlacklist();
// ── MIGRATION anciens noms Vinted
articles.forEach(a=>{
  if(a.vinted==='vinted1')a.vinted='tony';
  if(a.vinted==='vinted2')a.vinted='laetitia';
  if(a.vinted==='Vinted 1')a.vinted='tony';
  if(a.vinted==='Vinted 2')a.vinted='laetitia';
});
save();

// ── INIT
// ── SWIPE NAVIGATION
const SWIPE_SCREENS=['dashboard','stock','ventes','futurs','historique'];
let swipeStartX=0,swipeStartY=0,swipeTargetId=null;
document.querySelector('.content').addEventListener('touchstart',e=>{
  swipeStartX=e.touches[0].clientX;
  swipeStartY=e.touches[0].clientY;
  // Détecter si on swipe sur une carte stock
  const card=e.target.closest('.scard');
  swipeTargetId=card?card.dataset.id:null;
},{passive:true});
document.querySelector('.content').addEventListener('touchend',e=>{
  const dx=e.changedTouches[0].clientX-swipeStartX;
  const dy=e.changedTouches[0].clientY-swipeStartY;
  if(Math.abs(dy)>Math.abs(dx)*0.8)return;
  // Swipe sur carte stock
  if(swipeTargetId&&Math.abs(dx)>50){
    const art=articles.find(a=>a.id===swipeTargetId);
    if(art&&!['vendu','retour'].includes(art.statut)){
      if(dx>50&&art.statut==='stock'){art.statut='vente';save();renderStock();showToast('📢 Mis en vente');}
      else if(dx>50&&art.statut==='attente'){art.statut='stock';save();renderStock();showToast('📦 En stock');}
      else if(dx<-50&&art.statut==='vente'){art.statut='stock';save();renderStock();showToast('📦 Remis en stock');}
    }
    swipeTargetId=null;return;
  }
  // Swipe entre écrans DÉSACTIVÉ (utiliser les boutons en bas)
},{passive:true});



// ── 🔄 PULL-TO-REFRESH (sync cloud)
let _pullStartY=0,_pullCurY=0,_pulling=false,_pullInd=null,_refreshing=false;
function _createPullIndicator(){
  if(_pullInd)return;
  _pullInd=document.createElement('div');
  _pullInd.id='pullRefresh';
  _pullInd.style.cssText='position:fixed;top:-80px;left:50%;transform:translateX(-50%);width:48px;height:48px;background:#1fd99a;color:#000;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:22px;z-index:99999;transition:top .25s cubic-bezier(.34,1.56,.64,1);box-shadow:0 4px 20px rgba(31,217,154,0.4);pointer-events:none';
  _pullInd.innerHTML='🔄';
  document.body.appendChild(_pullInd);
}
async function _doRefresh(){
  if(_refreshing)return;
  _refreshing=true;
  if(_pullInd){_pullInd.innerHTML='<span class="spin" style="border-color:#000;border-top-color:transparent"></span>';_pullInd.style.top='calc(env(safe-area-inset-top, 20px) + 70px)';}
  // ✅ SÉCURITÉ : Pull-to-refresh = SEULEMENT refresh local, ZÉRO sauvegarde cloud!
  // Sinon les données d'un téléphone écrasent celles de l'autre.
  // La sync automatique se fait via checkCloudOnStart() (au démarrage) + scheduleCloudBackup() (après modifs)
  
  // Re-rendu écran actif
  const active=document.querySelector('.scr.on');
  if(active){
    const name=active.id.replace('screen-','');
    const renders={dashboard:renderDashboard,stock:renderStock,ventes:renderVentes,futurs:renderFuturs,historique:renderHisto,tracking:renderTracking,planning:renderCalendar,paiements:renderPaiements,marche:renderMarche,vendeurs:renderVendeurs};
    if(renders[name])renders[name]();
  }
  // Animation de fin
  setTimeout(()=>{
    if(_pullInd){
      _pullInd.style.top='-80px';
      setTimeout(()=>{if(_pullInd)_pullInd.innerHTML='🔄';},300);
    }
    _refreshing=false;
    showToast('🔄 Actualisé');
  },400);
}
document.querySelector('.content').addEventListener('touchstart',e=>{
  const c=e.currentTarget;
  if(c.scrollTop<=0&&!_refreshing){
    _pullStartY=e.touches[0].clientY;
    _pulling=true;
    _createPullIndicator();
  }
},{passive:true});
document.querySelector('.content').addEventListener('touchmove',e=>{
  if(!_pulling||_refreshing)return;
  _pullCurY=e.touches[0].clientY;
  const dist=_pullCurY-_pullStartY;
  if(dist>0&&_pullInd){
    const top=Math.min(20,-60+dist*0.4);
    _pullInd.style.top=top+'px';
    _pullInd.style.transform='translateX(-50%) rotate('+dist*2+'deg)';
  }
},{passive:true});
document.querySelector('.content').addEventListener('touchend',()=>{
  if(!_pulling)return;
  const dist=_pullCurY-_pullStartY;
  _pulling=false;
  if(dist>90){
    _doRefresh();
  }else if(_pullInd){
    _pullInd.style.top='-80px';
    _pullInd.style.transform='translateX(-50%) rotate(0deg)';
  }
  _pullStartY=0;_pullCurY=0;
},{passive:true});


// ── 🩺 DIAGNOSTIC (pour vérifier ce qui est en mémoire)
function showDebug(){
  const main=localStorage.getItem('rt-art');
  const bak=localStorage.getItem('rt-art-bak');
  const savedAt=localStorage.getItem('rt-saved-at');
  const cloudKey=localStorage.getItem('rt-cloud-key');
  const cloudLast=localStorage.getItem('rt-cloud-last');
  let storageSize=0;
  try{for(let k in localStorage)if(localStorage.hasOwnProperty(k))storageSize+=(localStorage[k].length+k.length);}catch(e){}
  // Détails statuts
  const statuts={};
  articles.forEach(a=>{
    const s=a.statut||'(vide)';
    statuts[s]=(statuts[s]||0)+1;
  });
  let statutsList='';
  Object.keys(statuts).forEach(s=>{statutsList+='   • '+s+' : '+statuts[s]+'\n';});
  // Détails du 1er article si présent
  let details='';
  if(articles.length>0){
    const a=articles[0];
    details='\n\n📋 1er article :\n'+
      '   nom: '+(a.nom||'(vide)')+'\n'+
      '   statut: "'+(a.statut||'(vide)')+'"\n'+
      '   plateforme: "'+(a.plateforme||'(vide)')+'"\n'+
      '   pa: '+(a.pa!==undefined?a.pa:'(undefined)')+'\n'+
      '   port: '+(a.port!==undefined?a.port:'(undefined)')+'\n'+
      '   pv: '+(a.pv||'(null)')+'\n'+
      '   vinted: '+(a.vinted||'(vide)')+'\n'+
      '   dateVente: '+(a.dateVente||'(vide)');
    // Récap rapide de tous les articles
    let recap='\n\n📊 Tous les articles :\n';
    articles.forEach((x,i)=>{
      const nphotos=(x.photos||[]).length;
      let phType='';
      if(nphotos>0){
        const p=x.photos[0];
        if(typeof p!=='string')phType='?';
        else if(p.startsWith('http'))phType='☁️R2';
        else if(p.startsWith('data:'))phType='💾data';
        else if(p.startsWith('p_'))phType='📦IDB';
        else phType='?';
      }
      recap+='   #'+(i+1)+' '+(x.nom||'?').substring(0,18)+' | photos:'+nphotos+(nphotos>0?'('+phType+')':'')+' | pa:'+(x.pa||0)+'\n';
    });
    details+=recap;
  }
  const msg='🩺 DIAGNOSTIC\n\n'+
    '📦 articles en mémoire : '+articles.length+'\n'+
    '   Statuts :\n'+statutsList+
    '💾 localStorage rt-art : '+(main?JSON.parse(main).length+' articles':'VIDE')+'\n'+
    '🔒 backup rt-art-bak : '+(bak?JSON.parse(bak).length+' articles':'VIDE')+'\n'+
    '🕐 Dernière sauvegarde : '+(savedAt?new Date(savedAt).toLocaleString('fr-FR'):'jamais')+'\n'+
    '☁️ Identifiant cloud : '+(cloudKey||'aucun')+'\n'+
    '☁️ Dernière sync cloud : '+(cloudLast?new Date(cloudLast).toLocaleString('fr-FR'):'jamais')+'\n'+
    '💽 Stockage utilisé : '+Math.round(storageSize/1024)+' Ko\n'+'🎯 Filtre Stock actif : '+stockFilter+details;
  alert(msg);
}

function showToast(msg){
  let t=document.getElementById('toast');
  if(!t){
    t=document.createElement('div');t.id='toast';
    t.style.cssText='position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) scale(0.8);background:#1fd99a;color:#000;padding:16px 28px;border-radius:14px;font-size:16px;font-weight:700;z-index:999999;box-shadow:0 10px 40px rgba(0,0,0,.5);transition:all .25s cubic-bezier(.34,1.56,.64,1);opacity:0;pointer-events:none;text-align:center;max-width:80vw';
    document.body.appendChild(t);
  }
  t.textContent=msg;
  t.style.opacity='1';
  t.style.transform='translate(-50%,-50%) scale(1)';
  clearTimeout(t._timer);
  t._timer=setTimeout(()=>{
    t.style.opacity='0';
    t.style.transform='translate(-50%,-50%) scale(0.8)';
  },2200);
  // Vibration légère sur iOS si dispo
  if(navigator.vibrate)try{navigator.vibrate(30);}catch(e){}
}

initColorPicker();
renderMarquesDatalist();
updateHeader();
renderDashboard();
// Pré-chargement photos depuis IndexedDB (rendu synchrone après)
preloadPhotos().then(()=>{
  renderDashboard();
  if(document.querySelector('#screen-stock.on'))renderStock();
}).catch(e=>console.warn('Preload photos failed:',e));

// 🔄 Cloud sync AUTOMATIQUE - séparé du preload pour s'exécuter TOUJOURS
setTimeout(()=>checkCloudOnStart(),2000);

// 🔄 Re-vérifier le cloud quand l'app revient en avant (changement d'onglet/appli)
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden){
    setTimeout(()=>checkCloudOnStart(),500);
  }
});

// 🔄 Re-vérifier au focus de la fenêtre (Android PWA)
window.addEventListener('focus',()=>{
  setTimeout(()=>checkCloudOnStart(),500);
});

if('serviceWorker' in navigator)navigator.serviceWorker.register('sw.js').catch(()=>{});