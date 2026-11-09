const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)];
let U=null,RT='';const me=()=>U;const msg=(el,t,ok)=>{el.textContent=t;el.style.color=ok?'var(--ok)':''};
const api=async(m,p,b)=>{const r=await fetch('/api'+p,{method:m,credentials:'same-origin',headers:{'X-Bionical':'1',...(b?{'Content-Type':'application/json'}:{})},body:b?JSON.stringify(b):undefined});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'Erreur serveur.');return j};
const DEF={theme:'auto',model:'qwen2.5-coder:7b',ctx:'8192',wifi:true,use:false};
let tt;const toast=m=>{const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(tt);tt=setTimeout(()=>t.classList.remove('on'),2600)};
const theme=u=>{const t=u?(u.settings||DEF).theme:'auto';t==='auto'?document.documentElement.removeAttribute('data-theme'):document.documentElement.dataset.theme=t};
const go=h=>{location.hash=h};

function nav(){
  const u=me(),a=$('#acts');a.innerHTML='';
  const mk=(t,h,c)=>{const e=document.createElement(h?'a':'button');e.textContent=t;e.className='btn '+(c||'');if(h)e.href=h;return e};
  if(u){a.append(mk('Profil','#profil','o'),mk('Se déconnecter',null,'o'));a.lastChild.dataset.out=1}
  else a.append(mk('Se connecter','#connexion','o'),mk('S’inscrire','#inscription'));
  $$('[data-guest]').forEach(e=>e.style.display=u?'none':'');
}
function route(){
  let [h,...rest]=(location.hash.slice(1)||'accueil').split('/');const u=me();RT=rest.join('/');
  if(!$('#v-'+h))h='accueil';
  if((h==='profil'||h==='parametres')&&!u){go('connexion');return}
  if((h==='connexion'||h==='inscription')&&u){go('profil');return}
  $$('.v').forEach(v=>v.classList.toggle('on',v.id==='v-'+h));
  $$('nav a').forEach(a=>a.classList.toggle('on',a.getAttribute('href')==='#'+h));
  nav();theme(u);
  if(h==='profil')fillProfile(u);
  if(h==='parametres')fillSettings(u);
  if(h==='teams')fillTeam(u);
  window.scrollTo(0,0);
}
addEventListener('hashchange',route);

/* Terminal */
const TABS={
cli:[['p','bionical pull qwen2.5-coder:7b'],['k','✓ 4,7 Go téléchargés, somme sha256 vérifiée'],['p','bionical run qwen2.5-coder:7b'],['d','> Écris un test pour parseDate()'],['o','Voici un test avec trois cas limites…'],['d','42 jetons/s · 0 octet envoyé sur le réseau']],
pc:[['o','Bionical Desktop 1.4 · Windows, macOS, Linux'],['o','Modèle   Llama 3.2 3B (Q4)'],['o','GPU      détecté, 6 Go alloués'],['o','Dossier  ~/projet · 126 fichiers indexés localement'],['k','✓ Mode avion actif, aucune connexion réseau']],
mob:[['o','Bionical Mobile · Android, iOS'],['o','Modèle   Phi 3.5 mini (Q4) · 2,2 Go'],['o','Réseau   hors ligne'],['d','14 jetons/s'],['k','✓ Synchronisation avec l’ordinateur en réseau local']]};
let run=0;
async function play(t){
  const id=++run,el=$('#term'),red=matchMedia('(prefers-reduced-motion:reduce)').matches;el.innerHTML='';
  for(const [c,s] of TABS[t]){
    if(id!==run)return;
    const d=document.createElement('div');d.className=c;el.append(d);
    if(c==='p'&&!red){for(const ch of s){d.textContent+=ch;await new Promise(r=>setTimeout(r,22));if(id!==run)return}await new Promise(r=>setTimeout(r,250))}
    else d.textContent=s;
  }
}
$('#cp').onclick=async()=>{try{await navigator.clipboard.writeText('curl -fsSL https://bionical.com/install | sh');toast('Commande copiée')}catch(e){toast('Copie impossible, sélectionnez la commande')}};

/* Auth */
$('#f-up').onsubmit=async e=>{e.preventDefault();const f=e.target,err=$('#e-up');err.textContent='';
  try{U=await api('POST','/auth/signup',{name:f.n.value,email:f.e.value,password:f.p.value});f.reset();toast('Compte créé');go('profil');route()}catch(x){err.textContent=x.message}};
$('#f-in').onsubmit=async e=>{e.preventDefault();const f=e.target,err=$('#e-in');err.textContent='';
  try{U=await api('POST','/auth/login',{email:f.e.value,password:f.p.value});f.reset();toast('Connecté');go('profil');route()}catch(x){err.textContent=x.message}};
document.addEventListener('click',async e=>{if(!e.target.closest('[data-out]'))return;try{await api('POST','/auth/logout')}catch(x){}U=null;theme(null);toast('Déconnecté');go('accueil');route()});

/* Profil */
function fillProfile(u){
  $('#av').textContent=u.name.trim().charAt(0).toUpperCase()||'?';
  $('#pn').textContent=u.name;$('#pe').textContent=u.email;$('#pp').textContent=u.plan;
  $('#pd').textContent=new Date(u.created).toLocaleDateString('fr-FR',{day:'numeric',month:'long',year:'numeric'});
  const f=$('#f-pr');f.n.value=u.name;f.e.value=u.email;$('#e-pr').textContent='';
}
$('#f-pr').onsubmit=async e=>{e.preventDefault();const f=e.target;
  try{U=await api('PATCH','/me',{name:f.n.value,email:f.e.value});toast('Profil enregistré');fillProfile(U)}catch(x){$('#e-pr').textContent=x.message}};

/* Paramètres */
const SM={theme:'#s-theme',model:'#s-model',ctx:'#s-ctx'},SC={wifi:'#s-wifi',use:'#s-use'};
function fillSettings(u){
  const s={...DEF,...u.settings};
  for(const k in SM)$(SM[k]).value=s[k];for(const k in SC)$(SC[k]).checked=s[k];
  $('#d-in').value='';$('#d-btn').disabled=true;$('#m-pw').textContent='';
}
async function saveSet(){
  if(!me())return;const s={};
  for(const k in SM)s[k]=$(SM[k]).value;for(const k in SC)s[k]=$(SC[k]).checked;
  try{U=await api('PUT','/me/settings',s);theme(U);toast('Paramètres enregistrés')}catch(x){toast(x.message)}
}
[...Object.values(SM),...Object.values(SC)].forEach(i=>$(i).onchange=saveSet);
$('#d-in').oninput=e=>{const u=me();$('#d-btn').disabled=!u||e.target.value.trim().toLowerCase()!==u.email};
$('#f-del').onsubmit=async e=>{e.preventDefault();if(!me())return;
  try{await api('DELETE','/me',{confirm:$('#d-in').value});U=null;theme(null);toast('Compte supprimé');go('accueil');route()}catch(x){toast(x.message)}};

/* Mot de passe */
$('#f-forgot').onsubmit=async e=>{e.preventDefault();const f=e.target,m=$('#m-forgot');msg(m,'',false);
  try{await api('POST','/auth/forgot',{email:f.e.value});f.reset();msg(m,'Si un compte existe avec cet e‑mail, un lien vient d’être envoyé. Il est valable 1 heure.',true)}catch(x){msg(m,x.message,false)}};
$('#f-reset').onsubmit=async e=>{e.preventDefault();const f=e.target,m=$('#m-reset');msg(m,'',false);
  try{await api('POST','/auth/reset',{token:RT,password:f.p.value});f.reset();toast('Mot de passe modifié. Connectez-vous.');go('connexion')}catch(x){msg(m,x.message,false)}};
$('#f-pw').onsubmit=async e=>{e.preventDefault();const f=e.target,m=$('#m-pw');msg(m,'',false);
  try{await api('POST','/me/password',{current:f.c.value,password:f.p.value});f.reset();msg(m,'Mot de passe modifié. Vos autres appareils ont été déconnectés.',true)}catch(x){msg(m,x.message,false)}};

/* Teams */
function fillTeam(u){
  const b=$('#team-in');b.innerHTML='';
  if(!u){b.innerHTML='<h3>Créez votre équipe</h3><p class="mut" style="margin-top:8px">Connectez-vous pour nommer votre équipe et inviter vos collègues.</p>';
    const a=document.createElement('a');a.className='btn';a.href='#inscription';a.textContent='Créer un compte';b.append(a);return}
  b.innerHTML='<h3>Mon équipe</h3><form id="f-team"><label>Nom de l’équipe<input name="n" required></label><label>Inviter par e‑mail<input name="e" type="email" placeholder="collegue@entreprise.com"></label><button class="btn" type="submit">Enregistrer et inviter</button></form><div id="mem" style="margin-top:20px"></div>';
  const t=u.team,f=$('#f-team');f.n.value=t.name;
  const list=()=>{const m=$('#mem');m.innerHTML='';
    t.members.forEach(x=>{const r=document.createElement('div');r.className='mem';const s=document.createElement('span'),bt=document.createElement('button');s.textContent=x;bt.textContent='Retirer';
      bt.onclick=async()=>{try{U=await api('DELETE','/team/members/'+encodeURIComponent(x));t.members=U.team.members;list()}catch(y){toast(y.message)}};r.append(s,bt);m.append(r)});
    if(!t.members.length)m.innerHTML='<p class="mut">Aucun membre invité pour le moment.</p>'};
  list();
  f.onsubmit=async e=>{e.preventDefault();try{U=await api('PUT','/team',{name:f.n.value});const em=f.e.value.trim();if(em)U=await api('POST','/team/members',{email:em});
    t.name=U.team.name;t.members=U.team.members;f.e.value='';list();toast('Équipe enregistrée')}catch(y){toast(y.message)}}
}

/* Facturation */
$$('[data-bill]').forEach(b=>b.onclick=()=>{const a=b.dataset.bill==='a';$$('[data-bill]').forEach(x=>x.setAttribute('aria-pressed',x===b));
  $$('[data-m]').forEach(e=>e.textContent=a?e.dataset.a:e.dataset.m);$$('[data-nm]').forEach(e=>e.textContent=a?e.dataset.na:e.dataset.nm)});

/* Contact */
$('#f-contact').onsubmit=async e=>{e.preventDefault();const f=e.target;
  try{await api('POST','/contact',{name:f.n.value,email:f.e.value,subject:f.s.value,message:f.m.value});f.reset();toast('Message envoyé')}catch(x){toast(x.message)}};

api('GET','/me').then(u=>{U=u}).catch(()=>{}).finally(()=>{play('cli');route()});
