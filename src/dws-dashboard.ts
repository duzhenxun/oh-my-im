import { createServer, type Server, type ServerResponse } from "node:http";

export type ReplyFormat = "markdown" | "plain";

export interface MonitorTarget { groupId: string; groupName: string; senderId: string; senderName: string; }
export interface DashboardConfig { targets: MonitorTarget[]; botAllowedUserIds: string[]; replyFormat: ReplyFormat; robotName: string; clientId: string; clientSecret: string; robotCode: string; }
interface PublicDashboardConfig extends Omit<DashboardConfig, "clientSecret"> { clientSecretConfigured: boolean; }
export interface ReplyRecord { id: string; createdAt: string; groupId: string; groupName: string; status: "processing" | "completed" | "failed"; question?: string; senderNames?: string[]; content: string; messageCount: number; }
export interface DashboardStatus { startedAt: string; eventConnected: boolean; lastEventAt?: string; activeBatches: number; }
export interface GroupMatch { groupId: string; groupName: string; memberCount?: number; }
export interface GroupMember { senderId: string; senderName: string; role?: string; }

export interface DashboardHooks {
  getConfig: () => DashboardConfig;
  updateConfig: (config: DashboardConfig) => Promise<void>;
  getStatus: () => DashboardStatus;
  getReplies: () => ReplyRecord[];
  searchGroups: (query: string) => Promise<GroupMatch[]>;
  listGroupMembers: (groupId: string) => Promise<GroupMember[]>;
}

export interface DashboardServerOptions {
  host?: string;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function publicConfig(config: DashboardConfig): PublicDashboardConfig {
  const { clientSecret, ...rest } = config;
  return { ...rest, clientSecretConfigured: Boolean(clientSecret) };
}

function normalizeConfig(value: unknown): DashboardConfig {
  if (!value || typeof value !== "object") throw new Error("配置必须是 JSON 对象");
  const source = value as { targets?: unknown; botAllowedUserIds?: unknown; replyFormat?: unknown; robotName?: unknown; clientId?: unknown; clientSecret?: unknown; robotCode?: unknown };
  if (!Array.isArray(source.targets)) throw new Error("钉钉规则格式无效");
  const keys = new Set<string>();
  const targets = source.targets.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`第 ${index + 1} 条钉钉规则无效`);
    const candidate = item as Partial<MonitorTarget>;
    const target: MonitorTarget = {
      groupId: candidate.groupId?.trim() ?? "", groupName: candidate.groupName?.trim() ?? "",
      senderId: candidate.senderId?.trim() ?? "", senderName: candidate.senderName?.trim() ?? "",
    };
    if (!target.groupId || !target.groupName || !target.senderId || !target.senderName) {
      throw new Error(`第 ${index + 1} 条规则的群或人员信息不完整`);
    }
    const key = `${target.groupId}:${target.senderId}`;
    if (keys.has(key)) throw new Error(`第 ${index + 1} 条规则重复`);
    keys.add(key);
    return target;
  });
  if (source.replyFormat !== "markdown" && source.replyFormat !== "plain") throw new Error("回复格式只能是 markdown 或 plain");
  if (!Array.isArray(source.botAllowedUserIds)) throw new Error("请至少配置一名机器人单聊授权人员");
  const botAllowedUserIds = [...new Set(source.botAllowedUserIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()).filter(Boolean))];
  if (botAllowedUserIds.length === 0) throw new Error("请至少配置一名机器人单聊授权人员");
  if (typeof source.robotName !== "string" || !source.robotName.trim()) throw new Error("请填写机器人名称");
  if (typeof source.clientId !== "string" || !source.clientId.trim()) throw new Error("请填写钉钉应用 Client ID");
  if (typeof source.clientSecret !== "string") throw new Error("Client Secret 格式无效");
  if (typeof source.robotCode !== "string" || !source.robotCode.trim()) throw new Error("请填写卡片机器人 Robot Code");
  return { targets, botAllowedUserIds, replyFormat: source.replyFormat, robotName: source.robotName.trim(), clientId: source.clientId.trim(), clientSecret: source.clientSecret.trim(), robotCode: source.robotCode.trim() };
}

export function startDashboard(port: number, hooks: DashboardHooks, options: DashboardServerOptions = {}): Server {
  const host = options.host?.trim() || "127.0.0.1";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(PAGE);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, { config: publicConfig(hooks.getConfig()), status: hooks.getStatus(), replies: hooks.getReplies() });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/groups") {
      const query = url.searchParams.get("q")?.trim() ?? "";
      if (!query) return sendJson(response, 400, { error: "请输入群名称" });
      void hooks.searchGroups(query).then((groups) => sendJson(response, 200, { groups })).catch((err) => {
        sendJson(response, 502, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    const membersMatch = url.pathname.match(/^\/api\/groups\/([^/]+)\/members$/);
    if (request.method === "GET" && membersMatch) {
      void hooks.listGroupMembers(decodeURIComponent(membersMatch[1])).then((members) => sendJson(response, 200, { members })).catch((err) => {
        sendJson(response, 502, { error: err instanceof Error ? err.message : String(err) });
      });
      return;
    }
    if (request.method === "PUT" && url.pathname === "/api/config") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        try {
          if (body.length > 100_000) throw new Error("请求内容过大");
          const config = normalizeConfig(JSON.parse(body));
          if (!config.clientSecret) config.clientSecret = hooks.getConfig().clientSecret;
          if (!config.clientSecret) throw new Error("请填写钉钉应用 Client Secret");
          void hooks.updateConfig(config).then(() => sendJson(response, 200, { config: publicConfig(config) })).catch((err) => {
            sendJson(response, 500, { error: err instanceof Error ? err.message : String(err) });
          });
        } catch (err) {
          sendJson(response, 400, { error: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }
    sendJson(response, 404, { error: "Not found" });
  });
  server.listen(port, host);
  return server;
}

const PAGE = String.raw`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>oh-my-im 控制台</title><style>
:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172033;background:#f4f6fa}*{box-sizing:border-box}body{margin:0}.wrap{max-width:1240px;margin:auto;padding:30px 24px 56px}header{display:flex;justify-content:space-between;gap:18px;margin-bottom:22px}h1{font-size:26px;margin:0}h2{font-size:17px;margin:0 0 14px}p{margin:6px 0;color:#596579}.status{font-size:13px;padding:8px 11px;border:1px solid #c8d1df;background:#fff;border-radius:6px;height:max-content}.connected{color:#047857}.stopped,.error{color:#b42318}.summary{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:18px}.metric,.panel{background:#fff;border:1px solid #dbe2ed;border-radius:7px}.metric{padding:12px}.metric small,.meta{color:#657287}.metric strong{display:block;font-size:18px;margin-top:5px}.grid{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:18px}.panel{padding:20px}.rule{border-top:1px solid #e7edf5;padding:16px 0}.rule:first-of-type{border-top:0;padding-top:0}.rule-grid{display:grid;grid-template-columns:minmax(380px,1.1fr) minmax(280px,1fr) 32px;gap:12px;align-items:start}.configured-grid{grid-template-columns:minmax(280px,.8fr) minmax(380px,1.2fr) 32px;align-items:center}.field{min-width:0}.field label{display:block;font-size:12px;font-weight:600;color:#526176;margin-bottom:6px}.rule-value{min-height:32px;display:flex;align-items:center;font-size:14px;color:#172033}.people{display:flex;flex-wrap:wrap;gap:6px}.person{padding:4px 8px;background:#f1f5fa;border-radius:4px;font-size:13px}.line{display:flex;gap:7px}.field input,.field select{width:100%;height:36px;padding:7px 9px;border:1px solid #c9d3e0;border-radius:5px;background:#fff;font:14px inherit;color:#172033}.field input:focus,.field select:focus{outline:2px solid #b9d7ff;border-color:#1677ff}.group-picker select{margin-top:7px}.member-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:2px 8px;max-height:106px;overflow:auto;border:1px solid #c9d3e0;border-radius:5px;background:#fff;padding:4px}.member-option{display:flex;align-items:center;min-width:0;min-height:28px;gap:10px;padding:4px 6px;font-size:13px;line-height:20px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.member-option:hover{background:#f2f7ff}.member-option input{width:14px;height:14px;flex:0 0 auto;align-self:center;margin:0;accent-color:#1677ff}.member-name{display:block;margin-left:2px;overflow:hidden;text-overflow:ellipsis}.member-role{color:#657287;font-size:11px;overflow:hidden;text-overflow:ellipsis}.search{height:36px;border:1px solid #1677ff;background:#1677ff;color:#fff;border-radius:5px;cursor:pointer;padding:0 12px;font:13px inherit;white-space:nowrap}.delete{height:36px;width:32px;border:0;background:transparent;color:#b42318;border-radius:5px;cursor:pointer;font-size:20px}.delete:hover{background:#fff0f0}.members{grid-column:1/3;font-size:12px;color:#657287;min-height:18px;padding-top:1px}.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-top:16px;padding-top:16px;border-top:1px solid #e7edf5}.button{border:0;border-radius:5px;background:#1677ff;color:#fff;padding:9px 13px;font:inherit;cursor:pointer}.secondary{background:#eef4ff;color:#175cd3}.format{display:flex;gap:10px;align-items:center;font-size:14px}.notice{min-height:20px;margin-top:12px;font-size:13px;color:#047857}.reply{border-top:1px solid #e8edf4;padding:15px 0}.reply:first-of-type{border-top:0;padding:0}.meta{font-size:12px;margin-bottom:7px}.reply pre{white-space:pre-wrap;word-break:break-word;margin:0;font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace}.empty{color:#657287;font-size:14px}@media(max-width:980px){.grid{grid-template-columns:1fr}.rule-grid,.configured-grid{grid-template-columns:minmax(300px,1fr) minmax(260px,1fr) 32px}.members{grid-column:1/3}}@media(max-width:640px){.wrap{padding:22px 14px 40px}header{display:block}.status{display:inline-block;margin-top:14px}.summary{grid-template-columns:1fr 1fr}.rule-grid,.configured-grid{grid-template-columns:1fr}.member-list{grid-template-columns:1fr 1fr}.members{grid-column:1}.delete{position:absolute;right:0;top:12px}.rule{position:relative;padding-right:38px}.toolbar{align-items:flex-start;flex-wrap:wrap}.format{order:3;width:100%}}
.robot-settings{margin-bottom:28px}.robot-settings .robot-row{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px 16px}@media(max-width:640px){.robot-settings .robot-row{grid-template-columns:1fr}}
.member-list{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;max-height:128px}.member-option{display:grid!important;grid-template-columns:18px max-content max-content;column-gap:4px;align-items:center;flex:0 0 auto;width:max-content;min-width:max-content;overflow:visible;white-space:nowrap}.member-option input{width:14px!important;height:14px!important;min-width:14px;margin:0!important}.member-name,.member-role{overflow:visible;text-overflow:clip;white-space:nowrap}
.reply{border:1px dashed #8fa4c2!important;border-radius:6px;padding:14px!important;background:#fff}.reply .meta{margin:0 0 6px;padding:9px 11px;border:1px solid #c8d7ec;border-radius:4px;background:#eaf2ff;box-shadow:inset 0 1px 0 #fff,0 2px 5px rgba(48,74,110,.16);font-size:15px;font-weight:700;color:#25324a}
@media(max-width:640px){body{min-width:0}.wrap{padding:16px 12px 32px}h1{font-size:22px;line-height:1.3}h2{font-size:18px;margin-bottom:12px}.panel{padding:14px}.robot-settings{margin-bottom:18px}.robot-settings .robot-row{gap:12px}.field label{font-size:13px}.field input,.field select,.search,.button{min-height:44px;height:44px;font-size:16px}.line{gap:8px}.line input{min-width:0}.search{padding:0 13px;flex:0 0 auto}.rule{padding:14px 42px 14px 0}.rule-grid,.configured-grid{gap:12px}.delete{top:17px;right:0;width:36px;height:44px;font-size:24px}.member-list{max-height:220px;padding:5px;gap:4px 6px;align-content:start}.member-option{min-height:40px;padding:8px 7px;column-gap:7px;font-size:15px}.member-option input{width:18px!important;height:18px!important;min-width:18px}.member-role{font-size:12px}.members{padding-top:3px;line-height:1.45}.toolbar{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;padding-top:14px}.toolbar .button{width:100%;padding:8px}.toolbar .format{grid-column:1/-1;order:0;display:flex;flex-wrap:wrap;gap:8px 12px;min-height:34px}.format span{width:100%;font-weight:600}.format label{display:inline-flex;align-items:center;min-height:30px}.format input{width:18px;height:18px;margin:0 5px 0 0}.reply{padding:10px!important}.reply .meta{padding:9px 10px;font-size:14px;line-height:1.45;word-break:break-word}.reply pre{font-size:12px!important}.notice{line-height:1.45}.status{font-size:13px}.empty{padding:4px 0}.grid{gap:14px}#replies{max-height:58vh!important}}
</style></head><body><main class="wrap"><header><div><h1>oh-my-im 控制台</h1><p>保存后立即生效。搜索并选择群，再从该群成员中选择需要监听的人。</p></div><div class="status" id="connection">加载中</div></header><section class="panel robot-settings"><h2>机器人设置</h2><div class="robot-row"><div class="field"><label>卡片机器人 Robot Code</label><input id="robotCode" placeholder="ding..."></div></div></section><section class="summary"><div class="metric"><small>监听规则</small><strong id="targetCount">-</strong></div><div class="metric"><small>处理中批次</small><strong id="activeBatches">-</strong></div><div class="metric"><small>最后收到消息</small><strong id="lastEvent">-</strong></div></section><div class="grid"><section class="panel"><h2>监听规则</h2><div id="rules"></div><div class="toolbar"><button class="button secondary" id="add">添加监听规则</button><div class="format"><span>回复格式</span><label><input type="radio" name="format" value="markdown"> Markdown</label><label><input type="radio" name="format" value="plain"> 纯文本</label></div><button class="button" id="save">保存并生效</button></div><div class="notice" id="notice"></div></section><section class="panel"><h2>Agent 最近回复</h2><div id="replies" class="empty">暂无回复</div></section></div></main><script>
const rules=document.querySelector('#rules'),notice=document.querySelector('#notice'),replyList=document.querySelector('#replies'),layout=document.querySelector('.grid'),rulesPanel=layout.firstElementChild,repliesPanel=layout.lastElementChild,robotSettings=document.querySelector('.robot-settings');document.querySelector('header p').remove();document.querySelector('.summary').remove();document.querySelector('#add').textContent='添加钉钉规则';robotSettings.querySelector('.robot-row').innerHTML='<div class="field"><label>机器人名称（备注）</label><input id="robotName" placeholder="例如：映客活动AI"></div><div class="field"><label>卡片机器人 Robot Code</label><input id="robotCode" placeholder="ding..."></div><div class="field"><label>钉钉应用 Client ID</label><input id="clientId" placeholder="ding..."></div><div class="field"><label>钉钉应用 Client Secret</label><input id="clientSecret" type="password" autocomplete="new-password" placeholder="已配置时留空不修改"></div><div class="field"><label>机器人单聊授权人员（钉钉用户 ID）</label><input id="botAllowedUserIds" placeholder="多个用户 ID 用逗号分隔"></div>';layout.replaceWith(rulesPanel,repliesPanel);repliesPanel.style.marginTop='18px';replyList.style.maxHeight='min(640px,calc(100vh - 180px))';replyList.style.overflowY='auto';replyList.style.display='flex';replyList.style.flexDirection='column-reverse';replyList.style.gap='12px';let loaded=false;setInterval(()=>refresh(false),1000);
const esc=v=>{const d=document.createElement('div');d.textContent=v??'';return d.innerHTML};const fmt=t=>t?new Date(t).toLocaleString('zh-CN',{hour12:false}):'-';const memberRole=role=>/群主|owner/i.test(role||'')?'(群主)':/管理|admin/i.test(role||'')?'(管理)':'';
function option(value,label){const o=document.createElement('option');o.value=value;o.textContent=label;return o}
function selectMembers(rule,members,selected=[]){const list=rule.querySelector('[data-key=senderId]'),hint=rule.querySelector('.members'),ids=new Set(selected);list.replaceChildren();members.forEach(m=>{const label=document.createElement('label');label.className='member-option';const box=document.createElement('input');box.type='checkbox';box.dataset.senderId=m.senderId;box.checked=ids.has(m.senderId);const name=document.createElement('span');name.className='member-name';name.textContent=m.senderName;label.append(box,name);const role=memberRole(m.role);if(role){const roleName=document.createElement('span');roleName.className='member-role';roleName.textContent=role;label.append(roleName)}list.append(label)});rule._members=members;hint.textContent='该群共加载 '+members.length+' 名人员，可勾选多个。'}
async function loadMembers(rule,groupId,selected){const hint=rule.querySelector('.members');hint.textContent='正在加载群成员...';try{const r=await fetch('/api/groups/'+encodeURIComponent(groupId)+'/members');const b=await r.json();if(!r.ok)throw new Error(b.error||'成员加载失败');selectMembers(rule,b.members,selected)}catch(e){hint.textContent=e.message;hint.className='members error'}}
function addDraftRule(){const rule=document.createElement('article');rule.className='rule';rule.innerHTML='<div class="rule-grid"><div class="field group-picker"><label>钉钉群</label><div class="line"><input data-key="groupName" placeholder="输入群名称"><button class="search" title="搜索群">搜索</button></div><select class="group"><option value="">搜索后选择精确群</option></select></div><div class="field"><label>钉钉人员</label><div data-key="senderId" class="member-list">选择群后加载成员</div><input data-key="groupId" type="hidden"></div><button class="delete" title="删除规则">×</button><div class="members"></div></div>';const groupName=rule.querySelector('[data-key=groupName]'),groupId=rule.querySelector('[data-key=groupId]'),groups=rule.querySelector('.group');rule.querySelector('.delete').onclick=()=>rule.remove();rule.querySelector('.search').onclick=async()=>{const q=groupName.value.trim();if(!q){notice.textContent='请输入群名称';notice.className='notice error';return}groups.replaceChildren(option('','正在搜索...'));try{const r=await fetch('/api/groups?q='+encodeURIComponent(q));const b=await r.json();if(!r.ok)throw new Error(b.error||'群搜索失败');groups.replaceChildren(option('','请选择精确群'));b.groups.forEach(g=>groups.append(option(g.groupId,g.groupName+'（'+(g.memberCount??'?')+' 人）')));if(!b.groups.length)notice.textContent='未找到匹配群';}catch(e){notice.textContent=e.message;notice.className='notice error'}};groups.onchange=()=>{const g=groups.options[groups.selectedIndex];groupId.value=groups.value;groupName.value=groups.value?g.textContent.replace(/（.*$/,''):groupName.value;if(groups.value)loadMembers(rule,groups.value,[])};rules.append(rule)}
async function loadConfiguredMembers(rule,group){const people=rule.querySelector('.people'),selected=new Set(group.targets.map(target=>target.senderId));people.textContent='正在加载群成员...';try{const r=await fetch('/api/groups/'+encodeURIComponent(group.groupId)+'/members'),body=await r.json();if(!r.ok)throw new Error(body.error||'成员加载失败');const members=[...body.members].sort((a,b)=>Number(selected.has(b.senderId))-Number(selected.has(a.senderId)));people.replaceChildren();members.forEach(member=>{const label=document.createElement('label');label.className='member-option';const box=document.createElement('input');box.type='checkbox';box.dataset.senderId=member.senderId;box.checked=selected.has(member.senderId);const name=document.createElement('span');name.className='member-name';name.textContent=member.senderName;label.append(box,name);const role=memberRole(member.role);if(role){const roleName=document.createElement('span');roleName.className='member-role';roleName.textContent=role;label.append(roleName)}people.append(label)});rule._members=members}catch(e){people.textContent=e.message;people.className='rule-value people error'}}
function addConfiguredRule(group){const rule=document.createElement('article');rule.className='rule';rule.innerHTML='<div class="rule-grid configured-grid"><div class="field"><label>钉钉群</label><div class="rule-value group-value"></div></div><div class="field"><label>钉钉人员</label><div class="member-list people"></div></div><button class="delete" title="删除规则">×</button></div>';rule._targets=group.targets;rule._group=group;rule.querySelector('.group-value').textContent=group.groupName;rule.querySelector('.delete').onclick=()=>rule.remove();rules.append(rule);void loadConfiguredMembers(rule,group)}
function renderStatic(data,replaceConfig=false){rulesPanel.querySelector('h2').textContent='钉钉规则 ('+data.config.targets.length+')';if(replaceConfig){document.querySelector('#robotName').value=data.config.robotName||'';document.querySelector('#clientId').value=data.config.clientId||'';document.querySelector('#clientSecret').value='';document.querySelector('#robotCode').value=data.config.robotCode||'';document.querySelector('#botAllowedUserIds').value=(data.config.botAllowedUserIds||[]).join(',')}const c=document.querySelector('#connection');c.textContent=data.status.eventConnected?'事件连接正常':'事件未连接';c.className='status '+(data.status.eventConnected?'connected':'stopped');const list=document.querySelector('#replies');if(!data.replies.length){list.className='empty';list.textContent='暂无回复';return}list.className='';list.innerHTML=data.replies.map(r=>{const state=r.status==='processing'?'处理中':r.status==='completed'?'完成':'失败',replyStyle=r.status==='processing'?'#fffbeb;color:#92400e':r.status==='completed'?'#ecfdf3;color:#166534':'#fff1f2;color:#b42318',question=typeof r.question==='string'&&r.question.trim(),senderNames=[...new Set((r.senderNames||[]).filter(Boolean))].join('、'),questionText=senderNames?senderNames+': '+r.question:r.question,questionBlock=question?'<div style="margin-top:6px;padding:8px;border-radius:4px;background:#eff6ff;color:#174ea6"><pre style="margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">'+esc(questionText)+'</pre></div>':'';return '<article class="reply"><div class="meta">'+esc(r.groupName)+' · '+fmt(r.createdAt)+' · '+state+' · '+r.messageCount+' 条消息</div>'+questionBlock+'<div style="margin-top:6px;padding:8px;border-radius:4px;background:'+replyStyle+'"><pre style="margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">'+esc(r.content)+'</pre></div></article>'}).join('')}
async function refresh(full=false){try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw new Error('读取状态失败');const data=await r.json();renderStatic(data,full);if(full){rules.replaceChildren();const grouped=new Map();data.config.targets.forEach(t=>{const key=t.groupId;if(!grouped.has(key))grouped.set(key,{groupId:t.groupId,groupName:t.groupName,targets:[]});grouped.get(key).targets.push(t)});grouped.forEach(addConfiguredRule);document.querySelector('input[name=format][value='+data.config.replyFormat+']').checked=true;loaded=true}}catch(e){notice.textContent=e.message;notice.className='notice error'}}
document.querySelector('#add').onclick=()=>addDraftRule();document.querySelector('#save').onclick=async()=>{const targets=[...rules.children].flatMap(rule=>{if(rule._targets&&!rule._members)return rule._targets;const groupId=rule._group?.groupId||rule.querySelector('[data-key=groupId]').value,groupName=rule._group?.groupName||rule.querySelector('[data-key=groupName]').value,members=rule._members||[],selected=[...rule.querySelectorAll('[data-sender-id]:checked')];return selected.map(box=>{const m=members.find(x=>x.senderId===box.dataset.senderId);return {groupId,groupName,senderId:box.dataset.senderId,senderName:m?m.senderName:''}})}),robotName=document.querySelector('#robotName').value.trim(),clientId=document.querySelector('#clientId').value.trim(),clientSecret=document.querySelector('#clientSecret').value.trim(),robotCode=document.querySelector('#robotCode').value.trim(),botAllowedUserIds=document.querySelector('#botAllowedUserIds').value.split(',').map(id=>id.trim()).filter(Boolean);const replyFormat=document.querySelector('input[name=format]:checked').value;notice.textContent='保存中...';notice.className='notice';try{const r=await fetch('/api/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({targets,botAllowedUserIds,replyFormat,robotName,clientId,clientSecret,robotCode})});const b=await r.json();if(!r.ok)throw new Error(b.error||'保存失败');notice.textContent='已保存，钉钉规则与机器人设置已立即生效。';await refresh(true)}catch(e){notice.textContent=e.message;notice.className='notice error'}};refresh(true);
</script></body></html>`;
