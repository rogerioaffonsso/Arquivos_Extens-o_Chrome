const ALARM_NAME = 'waSendAfonsoScheduledStart';
const ALARM_NEXT_CONTACT = 'waSendAfonsoNextContact';
let delayTimeout;
let keepAliveInterval;

function logToUI(msg, errorStr = '') {
  const fullMsg = `[Background] ${msg} ${errorStr ? ' -> ' + errorStr : ''}`;
  console.log(fullMsg);
  chrome.storage.local.get('logs', (res) => {
    let logs = res.logs || [];
    logs.push(`${new Date().toLocaleTimeString()} - ${fullMsg}`);
    if (logs.length > 50) logs = logs.slice(logs.length - 50);
    chrome.storage.local.set({ logs });
    chrome.runtime.sendMessage({ type: 'NEW_LOG' }).catch(() => {});
  });
}

chrome.runtime.onStartup.addListener(async () => {
  await chrome.alarms.clearAll();
  const { campaign } = await chrome.storage.local.get('campaign');
  if (campaign && campaign.status !== 'idle') {
    campaign.status = 'idle';
    campaign.isProcessing = false;
    campaign.nextSendAt = 0;
    await chrome.storage.local.set({ campaign });
  }
});

chrome.action.onClicked.addListener(async () => {
  const { uiWindowId } = await chrome.storage.local.get('uiWindowId');
  if (uiWindowId) {
    try {
      await chrome.windows.update(uiWindowId, { focused: true });
      return;
    } catch (e) {}
  }
  
  const win = await chrome.windows.create({
    url: 'popup.html',
    type: 'popup',
    width: 900,
    height: 800 
  });
  await chrome.storage.local.set({ uiWindowId: win.id });
});

chrome.runtime.onInstalled.addListener(async () => {
  const { campaign } = await chrome.storage.local.get('campaign');
  if (campaign?.settings?.scheduleAt) {
    await scheduleAlarm(campaign.settings.scheduleAt).catch(() => null);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SYSTEM_LOG') {
      logToUI(message.msg, message.error);
      sendResponse({ ok: true });
      return false;
  }
  
  handleMessage(message).then(sendResponse).catch(error => {
      logToUI('Erro ao processar mensagem', error.message);
      sendResponse({ ok: false, error: error.message });
  });
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
      const { campaign } = await chrome.storage.local.get('campaign');
      if (!campaign) return;
      logToUI('Alarme disparado. Preparando para iniciar...');
      campaign.status = 'running';
      campaign.isProcessing = false;
      campaign.nextSendAt = Date.now() + 5000;
      await chrome.storage.local.set({ campaign });
      setTimeout(() => processNextContact(), 5000);
  } else if (alarm.name === ALARM_NEXT_CONTACT) {
      logToUI('Fim da pausa. Retomando o processo de envios...');
      const { campaign } = await chrome.storage.local.get('campaign');
      if (!campaign || campaign.status !== 'running') return;
      await processNextContact();
  }
});

async function handleMessage(message) {
  switch (message.type) {
    case 'START_CAMPAIGN': {
      const { campaign } = await chrome.storage.local.get('campaign');
      if (!campaign) throw new Error('Campanha não encontrada no armazenamento local.');
      
      if (campaign.settings?.scheduleAt) {
        await scheduleAlarm(campaign.settings.scheduleAt);
        campaign.status = 'scheduled';
        await chrome.storage.local.set({ campaign });
        logToUI('Disparos agendados com sucesso.');
        return { ok: true, scheduled: true };
      }
      
      campaign.status = 'running';
      campaign.isProcessing = false;
      campaign.nextSendAt = Date.now() + 5000;
      await chrome.storage.local.set({ campaign });
      
      logToUI('Processo iniciado. O primeiro envio começará em 5 segundos.');
      setTimeout(() => {
        processNextContact().catch(e => logToUI('Erro crítico no processo principal', e.message));
      }, 5000);
      
      return { ok: true };
    }
    case 'CLEAR_CAMPAIGN': {
      await chrome.alarms.clearAll();
      clearTimeout(delayTimeout);
      clearInterval(keepAliveInterval);
      const { campaign } = await chrome.storage.local.get('campaign');
      if(campaign) {
          campaign.status = 'idle';
          campaign.nextSendAt = 0;
          campaign.isProcessing = false;
          await chrome.storage.local.set({ campaign });
      }
      logToUI('O processo foi parado pelo usuário. Aguardando novos comandos.');
      return { ok: true };
    }
    case 'CONTACT_SENT': {
      logToUI('Mensagem enviada com sucesso no WhatsApp.');
      await updateProgress('sent');
      await scheduleNext();
      return { ok: true };
    }
    case 'CONTACT_SKIPPED': {
      const phoneStr = message.payload?.phone || 'Desconhecido';
      const reason = message.payload?.reason;
      
      if (reason === 'recent_contact') {
          logToUI(`Contato ignorado pois já houve contato com ele nos últimos 7 dias: ${phoneStr}`);
          await updateProgress('ignored', phoneStr);
      } else if (reason === 'invalid') {
          logToUI(`O número ${phoneStr} não possui WhatsApp ou é inválido. Pulando para o próximo.`);
          await updateProgress('error', phoneStr);
      } else {
          logToUI(`Contato pulado por erro ou demora na tela: ${phoneStr}`);
          await updateProgress('error', phoneStr);
      }
      
      await scheduleNext();
      return { ok: true };
    }
    default:
      return { ok: false, error: 'Mensagem desconhecida.' };
  }
}

async function scheduleAlarm(datetimeLocal) {
  const when = new Date(datetimeLocal).getTime();
  if (!Number.isFinite(when) || when <= Date.now()) {
    throw new Error('Horário de agendamento inválido.');
  }
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { when });
}

async function processNextContact() {
  logToUI('Analisando o próximo contato da lista...');
  const { campaign } = await chrome.storage.local.get('campaign');
  if (!campaign || campaign.status !== 'running') {
      logToUI('O processo não está mais ativo. Ação abortada.');
      return;
  }
  
  campaign.isProcessing = true;
  campaign.nextSendAt = 0;
  await chrome.storage.local.set({ campaign });

  const contact = campaign.contacts?.[campaign.pointer ?? 0];
  
  if (!contact) {
    logToUI('Lista finalizada! Todos os contatos foram processados.');
    campaign.status = 'completed';
    await chrome.storage.local.set({ campaign });
    return;
  }

  const numberHeader = campaign.numberHeader;
  let phone = String(contact[numberHeader] || '').replace(/[^0-9]/g, '');
  
  logToUI(`Lendo contato da linha ${(campaign.pointer ?? 0) + 1}. Número: ${phone}`);

  if (!phone || phone.length < 8) {
    logToUI(`O número ${phone} está incompleto ou inválido. Pulando para o próximo.`);
    await updateProgress('error', phone);
    await scheduleNext();
    return;
  }

  let templatesArray = campaign.templates || [];
  if (!Array.isArray(templatesArray)) {
      templatesArray = campaign.template ? [campaign.template] : [];
  }
  
  const validTemplates = templatesArray.filter(t => t && t.trim() !== '');
  
  let chosenTemplate = '';
  if (validTemplates.length > 0) {
      const randomIndex = Math.floor(Math.random() * validTemplates.length);
      chosenTemplate = validTemplates[randomIndex];
      logToUI(`Mensagem sorteada: Opção ${randomIndex + 1}.`);
  } else {
      logToUI(`Atenção: Nenhuma mensagem foi escrita. O envio será vazio.`);
  }

  const message = renderTemplate(chosenTemplate, contact);
  const tab = await getOrCreateWhatsAppTab();
  
  if (tab.status !== 'complete' || !tab.url.includes('web.whatsapp.com')) {
      logToUI('Aguardando o navegador terminar de carregar o WhatsApp Web...');
      await new Promise(r => setTimeout(r, 6000));
  }

  const url = `https://web.whatsapp.com/send?phone=${phone}`;
  logToUI(`Abrindo a conversa com o contato para checar histórico...`);

  const payloadData = {
    type: 'PROCESS_CONTACT',
    payload: { phone, message, campaign, url }
  };

  const trySendMessage = (tabId, msg, maxRetries = 4) => {
      return new Promise((resolve, reject) => {
          let attempts = 0;
          const attempt = () => {
              attempts++;
              chrome.tabs.get(tabId, (t) => {
                  if (chrome.runtime.lastError || !t) {
                      return reject(new Error("Aba do WhatsApp fechada ou inacessível."));
                  }
                  chrome.tabs.sendMessage(tabId, msg).then(resolve).catch(err => {
                      if (err.message.includes('Receiving end does not exist')) {
                          logToUI(`Aba desatualizada ou adormecida detectada. Forçando sincronização imediata...`);
                          return reject(err);
                      }
                      
                      if (attempts >= maxRetries) {
                          reject(err);
                      } else {
                          logToUI(`Aguardando resposta do WhatsApp (tentativa ${attempts})...`);
                          setTimeout(attempt, 2000);
                      }
                  });
              });
          };
          attempt();
      });
  };

  try {
      await trySendMessage(tab.id, payloadData, 4);
  } catch(err) {
      logToUI(`O WhatsApp precisa ser atualizado para destravar a conexão...`);
      
      const reloadKey = 'reloaded_' + phone;
      chrome.storage.local.get([reloadKey], (res) => {
          if (res[reloadKey]) {
              logToUI(`A aba já foi atualizada e não resolveu. Pulando contato para evitar loop eterno.`);
              chrome.storage.local.remove([reloadKey]);
              updateProgress('error', phone).then(scheduleNext);
          } else {
              chrome.storage.local.set({ [reloadKey]: true });
              chrome.tabs.update(tab.id, { url: 'https://web.whatsapp.com/' });
              
              setTimeout(() => {
                  processNextContact().catch(e => logToUI('Erro ao retomar o contato.', e.message));
              }, 12000);
          }
      });
  }
}

async function scheduleNext() {
  const { campaign } = await chrome.storage.local.get('campaign');
  if (!campaign || campaign.status !== 'running') return;
  
  const processed = (campaign.metrics.sent || 0) + (campaign.metrics.errors || 0) + (campaign.metrics.ignored || 0);
  const batchSize = Math.max(1, Number(campaign.settings.batchSize || 10));
  const batchPauseMs = Math.max(1, Number(campaign.settings.batchPauseMin || 7)) * 60 * 1000;
  
  const baseMs = Math.max(1, Number(campaign.settings.minDelaySec || 5)) * 1000;
  const useRandom = Boolean(campaign.settings.useRandomDelay);
  
  const isBatchBoundary = processed > 0 && processed % batchSize === 0;
  
  let delayMs = 3000;
  
  if (isBatchBoundary) {
      delayMs = batchPauseMs;
      logToUI(`Pausa de lote atingida. O sistema descansará por ${batchPauseMs/60000} minutos.`);
  } else {
      delayMs = useRandom ? randomBetween(15000, 45000) : baseMs;
      logToUI(`Tempo de segurança entre envios definido para ${(delayMs/1000).toFixed(1)} segundos.`);
  }

  campaign.isProcessing = false;
  campaign.nextSendAt = Date.now() + delayMs;
  await chrome.storage.local.set({ campaign });
  
  clearTimeout(delayTimeout);
  clearInterval(keepAliveInterval);

  chrome.alarms.create(ALARM_NEXT_CONTACT, { when: campaign.nextSendAt });

  if (delayMs > 60000) { 
      logToUI(`Alarme do sistema configurado para acordar a extensão com segurança em ${Math.round(delayMs/60000)} minutos.`);
  } else {
      keepAliveInterval = setInterval(() => {
          chrome.storage.local.get('campaign'); 
      }, 5000);

      delayTimeout = setTimeout(() => {
          clearInterval(keepAliveInterval);
          processNextContact().catch(e => logToUI('Erro ao arrancar contato após delay', e.message));
      }, delayMs);
  }
}

async function updateProgress(type, phone = null) {
  const { campaign } = await chrome.storage.local.get('campaign');
  if (!campaign) return;
  campaign.metrics = campaign.metrics || { sent: 0, skipped: 0, errors: 0, ignored: 0 };
  campaign.failedNumbers = campaign.failedNumbers || [];
  campaign.ignoredNumbers = campaign.ignoredNumbers || [];

  if (type === 'sent') {
      campaign.metrics.sent = (campaign.metrics.sent || 0) + 1;
  } else if (type === 'error') {
      campaign.metrics.errors = (campaign.metrics.errors || 0) + 1;
      if (phone) campaign.failedNumbers.push(phone);
  } else if (type === 'ignored') {
      campaign.metrics.ignored = (campaign.metrics.ignored || 0) + 1;
      if (phone) campaign.ignoredNumbers.push(phone);
  }
  
  campaign.metrics.skipped = (campaign.metrics.errors || 0) + (campaign.metrics.ignored || 0);

  campaign.pointer = (campaign.pointer ?? 0) + 1;
  await chrome.storage.local.set({ campaign });
}

async function getOrCreateWhatsAppTab() {
  let tabs = await chrome.tabs.query({ url: ['*://web.whatsapp.com/*'] });
  if (tabs.length) {
    let tab = tabs[0];
    if(!tab.active) {
       await chrome.tabs.update(tab.id, { active: true });
    }
    return tab;
  }
  logToUI('WhatsApp não estava aberto. Abrindo nova aba...');
  const newTab = await chrome.tabs.create({ url: 'https://web.whatsapp.com/', active: true });
  logToUI('Aguardando 10 segundos para o WhatsApp carregar os arquivos iniciais...');
  await new Promise(r => setTimeout(r, 10000));
  
  tabs = await chrome.tabs.query({ url: ['*://web.whatsapp.com/*'] });
  return tabs.length ? tabs[0] : newTab;
}

function renderTemplate(template, contact) {
  if (!template) return '';
  return String(template).replace(/\{([^}]+)\}/g, (match, token) => {
    if (contact[token] !== undefined) return contact[token];
    return match; 
  });
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
