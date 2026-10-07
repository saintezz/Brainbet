const items=[];
let exchangeListingPage={offset:0,limit:24,total:0,nextOffset:0,hasMore:false};
let exchangeLoadingMore=false;
let exchangeInitData="";
let exchangeBrowserSession=false;
let exchangeCsrfToken="";
let exchangeBootstrapped=false;
let exchangeRefreshTimer=null;
let exchangeGuarantors=[];
const adminGuarantorLimitDrafts=new Map();
const adminGuarantorSaving=new Set();
let guaranteeDeals=[];
let adminUsers=[];
let reserveWithdrawalRequests=[];
let exchangeCapabilities={};
let adminOpenRequestCount=0;
let adminThreadPage={offset:0,limit:100,total:0,nextOffset:0,hasMore:false,query:"",callsOnly:false};
let adminThreadResultIds=[];
let adminThreadMode="";
let adminThreadsLoading=false;
let adminThreadLoadToken=0;
let adminThreadSearchTimer=null;
let pendingAdminHelpThreadId=null;
let adminHelpSubmitting=false;
let blockedUsers=[];
let blockedUserIds=new Set();
const chatDrafts=new Map();
let conversationPanel=null;
let conversationPanelThreadId=null;
const terminalDealStatuses=new Set(["completed","cancelled","refunded","compensated"]);
const exchangeEmbeddingOrigin=(()=>{
 const current=window.location.origin;
 if(current&&current!=="null")return current;
 try{return window.parent.location.origin}catch(error){return "*"}
})();

// Visual preference only; the parent remains responsible for authentication.
function syncExchangeDesign(payload={}){
 const rawDesign=payload.ui_design;
 const baseTheme=payload.ui_theme||payload.parentTheme;
 const design=rawDesign==="ultra"||rawDesign==="classic-refresh"||rawDesign==="classic"?"ultra"
  :rawDesign==="modern"?"modern"
  :baseTheme==="classic"||baseTheme==="classic-refresh"||baseTheme==="ultra"?"ultra":"modern";
 document.documentElement.dataset.uiDesign=design;
 document.documentElement.dataset.parentTheme=design==="ultra"?"classic":"modern";
}
window.addEventListener("storage",event=>{
 if(window.parent!==window||event.key!=="bb_ui_theme")return;
 syncExchangeDesign({ui_design:event.newValue});
 if(event.newValue==="classic"||event.newValue==="classic-refresh"){
  try{localStorage.setItem("bb_ui_theme","ultra")}catch(error){}
 }
});

function syncExchangeViewport(){
 const viewport=window.visualViewport;
 const height=Math.max(320,Math.round(viewport?.height||window.innerHeight||document.documentElement.clientHeight||720));
 const top=Math.max(0,Math.round(viewport?.offsetTop||0));
 document.documentElement.style.setProperty("--exchange-viewport-height",`${height}px`);
 document.documentElement.style.setProperty("--exchange-viewport-top",`${top}px`);
}
syncExchangeViewport();
window.addEventListener("resize",syncExchangeViewport,{passive:true});
window.visualViewport?.addEventListener("resize",syncExchangeViewport,{passive:true});
window.visualViewport?.addEventListener("scroll",syncExchangeViewport,{passive:true});
const cashCurrencies={
 BYN:{symbol:"Br",name:"Белорусский рубль"},
 RUB:{symbol:"₽",name:"Российский рубль"},
 USD:{symbol:"$",name:"Доллар США"},
 EUR:{symbol:"€",name:"Евро"},
 UAH:{symbol:"₴",name:"Гривна"}
};
let exchangeCurrencyRates={RUB:{rubPerUnit:1}};
let currencyRatesRequested=false;
const displayCurrencyStorageKey="brainbet_exchange_display_currency";
let displayCashCurrency=String(localStorage.getItem(displayCurrencyStorageKey)||"RUB").toUpperCase();
if(!cashCurrencies[displayCashCurrency])displayCashCurrency="RUB";

function cashCurrency(item){
 const code=String(item?.cashCurrency||item?.currency||"RUB").toUpperCase();
 return cashCurrencies[code]?code:"RUB";
}
function formatCurrencyNumber(value){
 const number=Number(value);
 if(!Number.isFinite(number))return "0";
 return number.toLocaleString(language==="en"?"en-US":"ru-RU",{
  minimumFractionDigits:Number.isInteger(number)?0:2,
  maximumFractionDigits:2
 });
}
function convertCashAmount(amount,sourceCurrency="RUB",targetCurrency=displayCashCurrency){
 const source=cashCurrencies[sourceCurrency]?sourceCurrency:"RUB";
 const target=cashCurrencies[targetCurrency]?targetCurrency:"RUB";
 const sourceRate=Number(exchangeCurrencyRates[source]?.rubPerUnit);
 const targetRate=Number(exchangeCurrencyRates[target]?.rubPerUnit);
 if(!Number.isFinite(sourceRate)||sourceRate<=0||!Number.isFinite(targetRate)||targetRate<=0)return null;
 return Number(amount)*sourceRate/targetRate;
}
function formatOriginalCashPrice(amount,currency="RUB"){
 const code=cashCurrencies[currency]?currency:"RUB";
 return `${formatCurrencyNumber(amount)} ${code}`;
}
function formatCashPrice(amount,currency="RUB"){
 const source=cashCurrencies[currency]?currency:"RUB";
 const converted=convertCashAmount(amount,source,displayCashCurrency);
 return `${formatCurrencyNumber(converted==null?amount:converted)} ${converted==null?source:displayCashCurrency}`;
}
function cashCurrencyOnly(item){return item?.cash!=null&&item?.cashCurrencyOnly===true}
function cashValueInRub(item){
 if(item?.cash==null)return null;
 const code=cashCurrency(item);
 const rate=Number(exchangeCurrencyRates[code]?.rubPerUnit);
 return Number.isFinite(rate)&&rate>0?Number(item.cash)*rate:null;
}
function cashValueInDisplayCurrency(item){
 if(item?.cash==null)return null;
 return convertCashAmount(item.cash,cashCurrency(item),displayCashCurrency);
}
function syncDisplayCurrencyControl(){
 const select=document.querySelector("#displayCurrencySelect");
 if(select)select.value=displayCashCurrency;
 const anyCurrencyOption=document.querySelector('#filterCashCurrency option[value=""]');
 if(anyCurrencyOption)anyCurrencyOption.textContent=language==="en"
  ?`Any source currency · shown in ${displayCashCurrency}`
  :`Любая исходная · показ в ${displayCashCurrency}`;
}
function setDisplayCashCurrency(code){
 const next=String(code||"").toUpperCase();
 if(!cashCurrencies[next]||next===displayCashCurrency)return;
 displayCashCurrency=next;
 localStorage.setItem(displayCurrencyStorageKey,displayCashCurrency);
 syncDisplayCurrencyControl();
 render();
 if(selectedId)openDeal(selectedId);
 if(!document.querySelector("#messenger")?.classList.contains("hidden"))renderMessenger();
 if(!document.querySelector("#guaranteeConsole")?.classList.contains("hidden"))renderGuaranteeConsole();
 if(!document.querySelector("#adminConsole")?.classList.contains("hidden"))renderAdminConsole();
}
async function loadExchangeCurrencies(){
 if(currencyRatesRequested||(!exchangeInitData&&!exchangeBrowserSession))return;
 currencyRatesRequested=true;
 try{
  const data=await exchangeFetch("/api/exchange/currencies");
  exchangeCurrencyRates=data.currencies||exchangeCurrencyRates;
  syncDisplayCurrencyControl();
  render();
  if(selectedId)openDeal(selectedId);
  if(!document.querySelector("#messenger").classList.contains("hidden"))renderMessenger();
 }catch(error){
  console.warn("exchange currencies",error);
  currencyRatesRequested=false;
 }
}

async function exchangeFetch(path,options={}){
 const headers=new Headers(options.headers||{});
 if(exchangeInitData)headers.set("X-Telegram-Init-Data",exchangeInitData);
 const method=String(options.method||"GET").toUpperCase();
 if(exchangeBrowserSession&&exchangeCsrfToken&&!['GET','HEAD','OPTIONS'].includes(method)){
  headers.set("X-BrainBet-CSRF",exchangeCsrfToken);
 }
 if(options.body&&!headers.has("Content-Type"))headers.set("Content-Type","application/json");
 const response=await fetch(path,{...options,headers,cache:"no-store",credentials:"same-origin"});
 const data=await response.json().catch(()=>({error:"invalid_response"}));
 if(!response.ok){
  const error=new Error(data.error||`HTTP ${response.status}`);
  error.code=data.error||"request_failed";
  error.payload=data;
  error.status=response.status;
  throw error;
 }
 return data;
}

function replaceThread(nextThread){
 const normalized={...nextThread,id:String(nextThread.id)};
 const index=chatThreads.findIndex(thread=>String(thread.id)===normalized.id);
 if(index>=0){
  const previous=chatThreads[index];
  const preserveMessages=previous&&!previous.compact&&normalized.compact;
  const incomingMessages=normalized.messages||[];
  const knownMessageIds=new Set((previous.messages||[]).map(message=>String(message.id)));
  const unseenMessages=incomingMessages.filter(message=>!knownMessageIds.has(String(message.id)));
  const merged=preserveMessages
   ?{...normalized,messages:[...(previous.messages||[]),...unseenMessages],compact:unseenMessages.length>0}
   :normalized;
  chatThreads.splice(index,1,merged);
  return merged;
 }
 chatThreads.unshift(normalized);
 return normalized;
}

async function loadExchangeThreadDetail(threadId){
 const current=chatThreads.find(thread=>String(thread.id)===String(threadId));
 if(current&&!current.compact)return current;
 const data=await exchangeFetch(`/api/exchange/threads/${encodeURIComponent(threadId)}`);
 return replaceThread({...data.thread,compact:false});
}

function replaceListing(nextListing){
 const index=items.findIndex(item=>Number(item.id)===Number(nextListing.id));
 if(index>=0){
  const previous=items[index];
  const preserveDetails=previous&&!previous.compact&&nextListing.compact;
  items.splice(index,1,preserveDetails?{...nextListing,screenshots:previous.screenshots||[],compact:false}:nextListing);
 }else items.push(nextListing);
 return items.find(item=>Number(item.id)===Number(nextListing.id));
}

async function loadMoreExchangeListings(){
 if(exchangeLoadingMore||!exchangeListingPage.hasMore)return;
 exchangeLoadingMore=true;
 render();
 try{
  const data=await exchangeFetch(`/api/exchange/listings?offset=${exchangeListingPage.nextOffset}&limit=${exchangeListingPage.limit}`);
  (data.listings||[]).forEach(replaceListing);
  exchangeListingPage={...exchangeListingPage,...(data.listingPage||{})};
  render();
 }catch(error){
  console.error("exchange listings page",error);
 }finally{
  exchangeLoadingMore=false;
  render();
 }
}

async function loadExchangeListingDetail(id){
 const current=items.find(item=>Number(item.id)===Number(id));
 if(current&&!current.compact)return current;
 const data=await exchangeFetch(`/api/exchange/listings/${Number(id)}`);
 return replaceListing({...data.listing,compact:false});
}

async function loadExchangeState({quiet=false}={}){
 if(!exchangeInitData&&!exchangeBrowserSession)return;
 const composerWasFocused=document.activeElement?.id==="messengerInput";
 try{
  const data=await exchangeFetch("/api/exchange/bootstrap?listing_limit=24&listing_offset=0");
  if(quiet){
   (data.listings||[]).forEach(replaceListing);
   exchangeListingPage={
    ...exchangeListingPage,
    total:Number(data.listingPage?.total||exchangeListingPage.total),
    hasMore:exchangeListingPage.nextOffset<Number(data.listingPage?.total||0)
   };
  }else{
   items.splice(0,items.length,...(data.listings||[]));
   exchangeListingPage={...exchangeListingPage,...(data.listingPage||{})};
  }
  pausedListingIds=new Set(items.filter(item=>item.status==="paused").map(item=>item.id));
  deletedListingIds=new Set();
  if(quiet)(data.threads||[]).forEach(replaceThread);
  else{
   chatThreads=(data.threads||[]).map(thread=>({...thread,id:String(thread.id)}));
   adminThreadPage={...adminThreadPage,...(data.threadPage||{})};
   adminThreadResultIds=chatThreads.map(thread=>String(thread.id));
   adminThreadMode="";
  }
  adminOpenRequestCount=Number(data.adminOpenRequestCount||0);
  currentAccount={...data.user,color:"#51314c"};
  restrictedSellers=new Set(data.restrictedSellers||[]);
  blockedUsers=data.blockedUsers||[];
  blockedUserIds=new Set(blockedUsers.map(entry=>Number(entry.tg_id)));
  adminAudit=data.audit||[];
  exchangeGuarantors=data.guarantors||[];
  guaranteeDeals=data.guaranteeDeals||[];
  adminUsers=data.adminUsers||[];
  reserveWithdrawalRequests=data.reserveWithdrawalRequests||[];
  exchangeCapabilities=data.capabilities||{};
  exchangeBootstrapped=true;
  renderAccounts();
  render();
  renderChatBadge();
  renderGuarantorBadge();
  if(!document.querySelector("#guaranteeConsole").classList.contains("hidden"))renderGuaranteeConsole();
  if(!document.querySelector("#messenger").classList.contains("hidden")&&!composerWasFocused)renderMessenger();
  const activeThread=chatThreads.find(thread=>thread.id===activeThreadId);
  if(quiet&&activeThread?.compact&&!document.querySelector("#messenger").classList.contains("hidden")){
   void loadExchangeThreadDetail(activeThread.id).then(()=>{
    if(activeThreadId===activeThread.id&&!composerWasFocused)renderMessenger();
   }).catch(error=>console.error("exchange active thread refresh",error));
  }
  if(!document.querySelector("#adminConsole").classList.contains("hidden"))renderAdminConsole();
  void loadExchangeCurrencies();
 }catch(error){
  console.error("exchange bootstrap",error);
  if(!quiet)alert(error.message==="unauthorized"?"Войди через Telegram в BrainBet и попробуй снова":"Не удалось загрузить биржу");
 }
}

window.addEventListener("message",event=>{
 if(event.origin!==exchangeEmbeddingOrigin)return;
 if(event.data?.type==="brainbet-exchange-theme"){
  syncExchangeDesign(event.data);
  return;
 }
 if(event.data?.type==="brainbet-exchange-auth"){
  syncExchangeDesign(event.data);
  exchangeInitData=String(event.data.initData||"");
  exchangeBrowserSession=Boolean(event.data.browserSession);
  exchangeCsrfToken=String(event.data.csrfToken||"");
  if(exchangeInitData||exchangeBrowserSession){
   void loadExchangeState();
   if(!exchangeRefreshTimer)exchangeRefreshTimer=setInterval(()=>void loadExchangeState({quiet:true}),15000);
  }
  return;
 }
 if(event.data?.type==="brainbet-exchange-navigate"){
  closeMessenger();
  closeReserveWallet();
  closeGuaranteeConsole();
  closeAdminConsole();
  closeMobilePanels();
  closeScreenshotViewer();
  closeModal();
  const targetName=event.data.target==="mine"?"mine":"market";
  const target=document.querySelector(`.tab[data-tab="${targetName}"]`);
  if(target)target.click();
  document.querySelector("main")?.scrollTo({top:0,left:0,behavior:"auto"});
 }
});
try{
 if(window.parent!==window)window.parent.postMessage({type:"brainbet-exchange-ready"},exchangeEmbeddingOrigin);
}catch(error){}

document.querySelector("#exchangeExitBtn")?.addEventListener("click",()=>{
 try{
  if(window.parent!==window){
   window.parent.postMessage({type:"brainbet-exchange-exit"},exchangeEmbeddingOrigin);
   return;
  }
 }catch(error){}
 if(window.history.length>1)window.history.back();
 else window.location.href="/";
});

const listingStorageKey="brainbet_exchange_server_managed";
try{
 const savedListings=JSON.parse(localStorage.getItem(listingStorageKey));
 if(Array.isArray(savedListings))savedListings.slice().reverse().forEach(saved=>{
  const existingIndex=items.findIndex(item=>item.id===saved.id);
  if(existingIndex>=0)items.splice(existingIndex,1);
  items.unshift(saved);
 });
}catch(error){}
const pausedListingStorageKey="brainbet_exchange_paused_server_managed";
let pausedListingIds=new Set();
try{
 const savedPaused=JSON.parse(localStorage.getItem(pausedListingStorageKey));
 if(Array.isArray(savedPaused))pausedListingIds=new Set(savedPaused);
}catch(error){}
function savePausedListings(){localStorage.setItem(pausedListingStorageKey,JSON.stringify([...pausedListingIds]))}
const deletedListingStorageKey="brainbet_exchange_deleted_server_managed";
let deletedListingIds=new Set();
try{
 const savedDeleted=JSON.parse(localStorage.getItem(deletedListingStorageKey));
 if(Array.isArray(savedDeleted))deletedListingIds=new Set(savedDeleted);
}catch(error){}
function saveDeletedListings(){localStorage.setItem(deletedListingStorageKey,JSON.stringify([...deletedListingIds]))}
function saveCustomListings(){
 try{
  localStorage.setItem(listingStorageKey,JSON.stringify(items.filter(item=>item.custom)));
  return true;
 }catch(error){
  console.error("listing storage",error);
  return false;
 }
}
let currentAccount={username:"@loading",name:"Loading",balance:0,color:"#51314c",isAdmin:false};
let activeTab="market",selectedId=null;
const exchangeFilters={
 intent:"all",
 methods:new Set(),
 allMethods:false,
 structure:"all",
 mutation:"",
 excludedMutation:"",
 traits:new Set(),
 excludedTraits:new Set(),
 traitMode:"any",
 traitSelectionMode:"include",
 exact:false,
 screenshots:false,
 hasMutation:false,
 hasTraits:false,
 noMutation:false,
 noTraits:false,
 strictCashCurrency:false,
 multipleMethods:false
};
const dealSelections=new Map();
let activeThreadId=null;
let chatQuery="";
let methodPickerThreadId=null;
let adminAllChatsMode=false;
const defaultChatThreads=[];
const chatStorageKey="brainbet_exchange_chat_threads_v1";
const exchangeDatabaseName="brainbet_exchange_demo_v1";
const exchangeStateStore="state";
function validChatThreads(value){
 return Array.isArray(value)&&value.every(thread=>thread&&thread.id&&thread.itemId&&thread.buyer&&thread.seller&&thread.mode&&Array.isArray(thread.messages));
}
function loadChatThreads(){
 return defaultChatThreads.map(thread=>({...thread,unreadFor:[...thread.unreadFor],messages:thread.messages.map(message=>({...message}))}));
}
let chatThreads=loadChatThreads();
function openExchangeDatabase(){
 return new Promise((resolve,reject)=>{
  const request=indexedDB.open(exchangeDatabaseName,1);
  request.onupgradeneeded=()=>{if(!request.result.objectStoreNames.contains(exchangeStateStore))request.result.createObjectStore(exchangeStateStore)};
  request.onsuccess=()=>resolve(request.result);
  request.onerror=()=>reject(request.error);
 });
}
async function saveChatThreadsToDatabase(){
 try{
  const database=await openExchangeDatabase();
  await new Promise((resolve,reject)=>{
   const transaction=database.transaction(exchangeStateStore,"readwrite");
   transaction.objectStore(exchangeStateStore).put(chatThreads,chatStorageKey);
   transaction.oncomplete=resolve;
   transaction.onerror=()=>reject(transaction.error);
  });
  database.close();
 }catch(error){console.error("chat indexedDB save",error)}
}
async function loadChatThreadsFromDatabase(){
 try{
  const database=await openExchangeDatabase();
  const saved=await new Promise((resolve,reject)=>{
   const request=database.transaction(exchangeStateStore,"readonly").objectStore(exchangeStateStore).get(chatStorageKey);
   request.onsuccess=()=>resolve(request.result);
   request.onerror=()=>reject(request.error);
  });
  database.close();
  return validChatThreads(saved)?saved:null;
 }catch(error){console.error("chat indexedDB load",error);return null}
}
function saveChatThreads(){
 return true;
}
let language=localStorage.getItem("exchange_language")||"ru";
const i18n={
 ru:{
  market_title:"Биржа предметов",market_intro:"Выставляй брейнротов, находи обмены и договаривайся в одной комнате.",create_listing:"＋ Создать предложение",
  all_offers:"Все предложения",wanted_items:"Ищут предметы",my_listings:"Мои объявления",saved:"Сохранённые",filters:"ФИЛЬТРЫ",item_name:"Название предмета",
  offer_type:"ТИП ПРЕДЛОЖЕНИЯ",additional:"ДОПОЛНИТЕЛЬНО",sorting:"СОРТИРОВКА",select_offer:"Выбери предложение",select_offer_hint:"Здесь появятся детали предмета, чат и кнопка обмена.",
  create_offer:"Создать предложение",demo_note:"Объявление увидят игроки BrainBet.",brainrot_search:"Начни вводить название...",trait_search:"Найти бафф...",
  picker_hint:"Выбрать можно только брейнротов из каталога. Можно добавить несколько и назначить каждому мутацию и баффы.",publish:"Опубликовать объявление",
  no_traits:"Подходящих баффов нет",loading_traits:"Загрузка баффов...",traits_load_error:"Не удалось загрузить каталог баффов",storage_error:"Не удалось сохранить объявление. Попробуй загрузить скриншоты меньшего размера.",traits_for:"БАФФЫ ДЛЯ",no_traits_selected:"без баффов",trait_count:"баффов",offers:"предложений",
  fresh_offers:"Свежие предложения",wanted_title:"Игроки ищут эти предметы",mine_title:"Мои объявления",saved_title:"Сохранённые предложения",
  my_balance:"МОЙ БАЛАНС",brainrots_in_offer:"БРЕЙНРОТЫ В ПРЕДЛОЖЕНИИ",sale:"Продажа",for_brains:"За мозги",trade:"Трейд",upload:"＋ Перетащи скриншоты сюда или нажми",up_to_files:"до 6 изображений · 6 МБ каждое · 10 МБ вместе",screenshots:"СКРИНШОТЫ ПРОДАВЦА",
  own:"МОЁ",edit:"✎ Редактировать",pause:"Ⅱ Снять с публикации",buy_for:"Купить за",contact_seller:"Связаться с продавцом по покупке",brains_word:"мозгов",pay_balance:"Предложить расчёт балансом BrainBet",offer_trade:"Предложить трейд",
  buyer_responses:"ОТКЛИКИ ПОКУПАТЕЛЕЙ",seller_chat:"ЧАТ С ПРОДАВЦОМ",owner_chat_hint:"Пока здесь показан пример входящего отклика.",buyer_chat_hint:"Привет! Выбирай удобный вариант сделки.",message:"Написать сообщение...",
  deal_selected:"Вариант выбран",write_details:"Напиши продавцу детали в чате",listing_paused:"Объявление снято",editor_open:"Редактор открыт",choose_deal:"Выбери хотя бы один вариант сделки",choose_brainrot:"Выбери хотя бы один брейнрот из каталога",consider_offers:"Рассмотрю предложения",
  multiple_options:"Несколько вариантов",up_to_500:"До 500 🧠",new_first:"Сначала новые",price_ascending:"Цена: по возрастанию",most_offers:"Больше откликов",seller_terms:"Условия выбирает продавец",seller_terms_hint:"Продажа, мозги и обмен могут быть включены одновременно.",updated_now:"Обновлено только что",
  found_short:"найдено",reset_all:"Сбросить всё",filter_search:"ПОИСК",seller_name:"ПРОДАВЕЦ",exact_item_match:"Точное совпадение названия",require_all_methods:"Должны быть все выбранные способы",price_and_income:"ЦЕНА И ДОХОД",brains_price:"Цена в мозгах",cash_price_short:"Цена в валюте",income_second:"Доход в секунду",items_and_quantity:"ПРЕДМЕТЫ И КОЛИЧЕСТВО",any:"Любые",single_item:"Один",bundle:"Набор",different_items:"Разных предметов",total_quantity:"Общее количество",attributes:"МУТАЦИИ И БАФФЫ",mutation:"МУТАЦИЯ",any_mutation:"Любая мутация",any_selected_trait:"Любой выбранный",all_selected_traits:"Все выбранные",with_screenshots:"Со скриншотами продавца",with_mutation:"Только с мутацией",with_traits:"Только с баффами",multiple_methods:"Несколько способов сделки",income_high:"Доход: сначала высокий",income_low:"Доход: сначала низкий",brains_low:"Мозги: сначала дешевле",brains_high:"Мозги: сначала дороже",cash_low:"Цена: сначала дешевле",cash_high:"Цена: сначала дороже",quantity_high:"Количество: сначала больше",show_results:"Показать"
  ,stars_price:"Цена в Telegram Stars",stars_low:"Stars: сначала дешевле",stars_high:"Stars: сначала дороже",strict_cash_currency:"Только с оплатой строго в выбранной валюте",required_attributes:"ДОЛЖНО БЫТЬ",excluded_attributes:"НЕ ДОЛЖНО БЫТЬ",forbidden_mutation:"ИСКЛЮЧИТЬ МУТАЦИЮ",any_forbidden_mutation:"Не исключать мутации",include_traits:"Требовать бафы",exclude_traits:"Исключать бафы",excluded_traits:"ИСКЛЮЧЁННЫЕ БАФЫ",without_mutations:"Строго без мутаций",without_traits:"Строго без бафов",attribute_rule_hint:"Выбери режим, затем нажимай на бафы. Запрещённый баф исключит весь набор.",
  nothing_found:"Ничего не найдено в каталоге",cash_price:"ЦЕНА ПРОДАЖИ",cash_placeholder:"Например, 25",currency:"ВАЛЮТА",any_currency:"Любая, пересчёт в RUB",currency_only:"Только за выбранную валюту",currency_only_hint:"Покупатель должен рассчитаться именно в этой валюте. Пересчёт будет только справочным.",currency_only_badge:"Только",currency_rate_note:"Для защищённой сделки курс фиксируется в момент запуска.",brain_price:"ЦЕНА В МОЗГАХ BRAINBET",brain_placeholder:"Например, 500",trade_for:"НА ЧТО ГОТОВ ОБМЕНЯТЬ",trade_placeholder:"Dragon Cannelloni, Cerberus или ваши предложения",traits_load_error:"Не удалось загрузить каталог traits",
  choose_payment:"ВЫБЕРИ ОДИН СПОСОБ СДЕЛКИ",selected_method:"ВЫБРАННЫЙ СПОСОБ",method_required:"Сначала выбери способ сделки",cash_method:"Покупка за деньги",brains_method:"Покупка за мозги",trade_method:"Обмен предметами",chat_with:"ЧАТ С",online:"в сети",negotiating:"ОБСУЖДЕНИЕ СДЕЛКИ",send:"Отправить",you:"Вы",today:"сегодня",incoming_requests:"ВХОДЯЩИЕ ОТКЛИКИ",active_request:"Активный отклик",buyer_ready:"Покупатель готов обсудить условия",write_seller:"Напиши продавцу сообщение...",write_buyer:"Ответить покупателю..."
  ,chats:"Чаты",all_chats:"ВСЕ ПЕРЕПИСКИ",search_chats:"Поиск по чатам...",choose_chat:"Выбери переписку",choose_chat_hint:"Здесь появятся сообщения и данные объявления.",no_chats:"У тебя пока нет чатов",no_chats_hint:"Выбери способ сделки в объявлении, чтобы начать диалог.",listing:"ОБЪЯВЛЕНИЕ",open_chats:"Открыть отклики",new_dialog:"Новый диалог создан"
  ,change_method:"Изменить способ",change_method_title:"ИЗМЕНЕНИЕ СПОСОБА СДЕЛКИ",method_changed:"Метод изменён на",cancel:"Отмена"
  ,method_fixed:"Способ зафиксирован для этого диалога",change_in_chat:"Другой способ можно выбрать только в чате",open_chat:"Открыть чат",seller_photo:"Фото продавца",photo_of:"Фото",close_photo:"Закрыть фото",previous_photo:"Предыдущее фото",next_photo:"Следующее фото",mutation_one:"МУТАЦИЯ",mutation_hint:"можно выбрать только одну",traits_many:"БАФФЫ",traits_hint:"можно выбрать несколько",no_mutation:"Без мутации",item_setup:"Настроить",item_config:"НАСТРОЙКА",edit_listing:"Редактировать объявление",save_changes:"Сохранить изменения",base_income:"БАЗОВЫЙ ДОХОД",total_multiplier:"ИТОГОВЫЙ МНОЖИТЕЛЬ",income_per_second:"ПРИНОСИТ В СЕКУНДУ",income_unknown:"Доход пока не найден"
 },
 en:{
  market_title:"Brainrot marketplace",market_intro:"List brainrots, find trades and negotiate in one place.",create_listing:"＋ Create listing",
  all_offers:"All listings",wanted_items:"Wanted items",my_listings:"My listings",saved:"Saved",filters:"FILTERS",item_name:"Brainrot name",
  offer_type:"OFFER TYPE",additional:"ADDITIONAL",sorting:"SORTING",select_offer:"Select a listing",select_offer_hint:"Item details, chat and deal actions will appear here.",
  create_offer:"Create listing",demo_note:"The listing will be visible to BrainBet players.",brainrot_search:"Start typing a brainrot name...",trait_search:"Find a trait...",
  picker_hint:"Only catalog brainrots can be selected. Add several and assign separate traits to each.",publish:"Publish listing",
  no_traits:"No matching traits",loading_traits:"Loading buffs...",traits_load_error:"Could not load the buffs catalog",storage_error:"Could not save the listing. Try smaller screenshots.",traits_for:"TRAITS FOR",no_traits_selected:"no traits",trait_count:"traits",offers:"offers",
  fresh_offers:"Fresh listings",wanted_title:"Players want these items",mine_title:"My listings",saved_title:"Saved listings",
  my_balance:"MY BALANCE",brainrots_in_offer:"BRAINROTS IN THIS LISTING",sale:"Sale",for_brains:"For brains",trade:"Trade",upload:"＋ Drop screenshots here or click",up_to_files:"up to 6 images · 6 MB each · 10 MB total",screenshots:"SELLER SCREENSHOTS",
  own:"MINE",edit:"✎ Edit",pause:"Ⅱ Unpublish",buy_for:"Buy for",contact_seller:"Contact the seller about this purchase",brains_word:"brains",pay_balance:"Offer payment with BrainBet balance",offer_trade:"Offer a trade",
  buyer_responses:"BUYER RESPONSES",seller_chat:"SELLER CHAT",owner_chat_hint:"This is a sample incoming response.",buyer_chat_hint:"Hi! Choose a convenient deal option.",message:"Write a message...",
  deal_selected:"Option selected",write_details:"Send the seller the details in chat",listing_paused:"Listing unpublished",editor_open:"Editor opened",choose_deal:"Choose at least one deal option",choose_brainrot:"Choose at least one brainrot from the catalog",consider_offers:"Open to offers",
  multiple_options:"Multiple options",up_to_500:"Up to 500 🧠",new_first:"Newest first",price_ascending:"Price: low to high",most_offers:"Most responses",seller_terms:"Seller chooses the terms",seller_terms_hint:"Cash, BrainBet brains and trade can be enabled together.",updated_now:"Updated just now",
  found_short:"found",reset_all:"Reset all",filter_search:"SEARCH",seller_name:"SELLER",exact_item_match:"Exact item name",require_all_methods:"Require every selected method",price_and_income:"PRICE AND INCOME",brains_price:"Price in brains",cash_price_short:"Cash price",income_second:"Income per second",items_and_quantity:"ITEMS AND QUANTITY",any:"Any",single_item:"Single",bundle:"Bundle",different_items:"Different items",total_quantity:"Total quantity",attributes:"MUTATIONS AND TRAITS",mutation:"MUTATION",any_mutation:"Any mutation",any_selected_trait:"Any selected",all_selected_traits:"All selected",with_screenshots:"With seller screenshots",with_mutation:"Only with mutation",with_traits:"Only with traits",multiple_methods:"Multiple deal methods",income_high:"Income: high first",income_low:"Income: low first",brains_low:"Brains: low first",brains_high:"Brains: high first",cash_low:"Price: low first",cash_high:"Price: high first",quantity_high:"Quantity: high first",show_results:"Show"
  ,stars_price:"Price in Telegram Stars",stars_low:"Stars: low first",stars_high:"Stars: high first",strict_cash_currency:"Only listings requiring the selected currency",required_attributes:"MUST HAVE",excluded_attributes:"MUST NOT HAVE",forbidden_mutation:"EXCLUDE MUTATION",any_forbidden_mutation:"Do not exclude mutations",include_traits:"Require traits",exclude_traits:"Exclude traits",excluded_traits:"EXCLUDED TRAITS",without_mutations:"Strictly no mutations",without_traits:"Strictly no traits",attribute_rule_hint:"Choose a mode, then select traits. A forbidden trait excludes the whole bundle.",
  nothing_found:"Nothing found in the catalog",cash_price:"SALE PRICE",cash_placeholder:"For example, 25",currency:"CURRENCY",any_currency:"Any, converted to RUB",currency_only:"Only in the selected currency",currency_only_hint:"The buyer must pay in this exact currency. Conversion is shown for reference only.",currency_only_badge:"Only",currency_rate_note:"Protected deals lock the exchange rate when the deal starts.",brain_price:"PRICE IN BRAINBET BRAINS",brain_placeholder:"For example, 500",trade_for:"WHAT YOU WANT IN EXCHANGE",trade_placeholder:"Dragon Cannelloni, Cerberus or other offers",traits_load_error:"Could not load the traits catalog",
  choose_payment:"CHOOSE ONE DEAL METHOD",selected_method:"SELECTED METHOD",method_required:"Choose a deal method first",cash_method:"Buy for cash",brains_method:"Buy with brains",trade_method:"Trade items",chat_with:"CHAT WITH",online:"online",negotiating:"DEAL DISCUSSION",send:"Send",you:"You",today:"today",incoming_requests:"INCOMING RESPONSES",active_request:"Active response",buyer_ready:"Buyer is ready to discuss the terms",write_seller:"Write a message to the seller...",write_buyer:"Reply to the buyer..."
  ,chats:"Chats",all_chats:"ALL CONVERSATIONS",search_chats:"Search chats...",choose_chat:"Choose a conversation",choose_chat_hint:"Messages and listing details will appear here.",no_chats:"You have no chats yet",no_chats_hint:"Choose a deal method in a listing to start a conversation.",listing:"LISTING",open_chats:"Open responses",new_dialog:"New conversation created"
  ,change_method:"Change method",change_method_title:"CHANGE DEAL METHOD",method_changed:"Method changed to",cancel:"Cancel"
  ,method_fixed:"The method is fixed for this conversation",change_in_chat:"Choose another method inside the chat",open_chat:"Open chat",seller_photo:"Seller photo",photo_of:"Photo",close_photo:"Close photo",previous_photo:"Previous photo",next_photo:"Next photo",mutation_one:"MUTATION",mutation_hint:"choose only one",traits_many:"TRAITS",traits_hint:"choose several",no_mutation:"No mutation",item_setup:"Configure",item_config:"CONFIGURE",edit_listing:"Edit listing",save_changes:"Save changes",base_income:"BASE INCOME",total_multiplier:"TOTAL MULTIPLIER",income_per_second:"INCOME PER SECOND",income_unknown:"Income not found yet"
 }
};
function t(key){return i18n[language][key]||key}
function applyLanguage(){
 document.documentElement.lang=language;
 document.querySelectorAll("[data-i18n]").forEach(element=>{const key=element.dataset.i18n;element.textContent=t(key)});
 document.querySelectorAll("[data-i18n-placeholder]").forEach(element=>{element.placeholder=t(element.dataset.i18nPlaceholder)});
 const toggle=document.querySelector("#languageToggle");if(toggle)toggle.textContent=language.toUpperCase();
 syncDisplayCurrencyControl();
 const titles={market:t("fresh_offers"),wanted:t("wanted_title"),mine:t("mine_title"),saved:t("saved_title")};
 const feedTitle=document.querySelector("#feedTitle");if(feedTitle)feedTitle.textContent=titles[activeTab];
 renderSelectedBrainrots?.();renderTraitEditor?.();render?.();renderChatBadge?.();if(selectedId)openDeal(selectedId);
 if(!document.querySelector("#messenger").classList.contains("hidden"))renderMessenger();
}
function isStandaloneBrainrotName(name){
 return typeof name==="string"&&Boolean(name.trim())&&!name.includes(" + ");
}
let brainrotCatalog=[...new Set([
 ...items.flatMap(item=>item.brainrots?.length?item.brainrots.map(brainrot=>brainrot.name):(isStandaloneBrainrotName(item.name)?[item.name]:[])),
 "Tung Tung Tung Sahur","Tralalero Tralala","Ballerina Cappuccina",
 "Bombardiro Crocodilo","Cappuccino Assassino","Los Tralaleritos",
 "Strawberry elephant","Spaghetti Tualetti","Tim Cheese","Tipi Topi Taco",
 "La Vacca Saturno Saturnita","Graipuss Medussi","Gorillo Watermelondrillo",
 "Cocofanto Elefanto","Las Vaquitas Saturnitas","Meowl","Jhon Pork",
 "Skibidi Toilet","Celestial Pegasus","Fragola La La La","Foxini Lanterini",
 "Popcuru and Fizzuru","Cookie and Milki","Reinito Sleighito",
 "Fortunu and Cashuru","Burguro And Fryro","Cash or Card"
])].filter(isStandaloneBrainrotName),selectedBrainrots=[];
let brainrotIncomes=[];
let brainrotIncomeByName=new Map();
const brainrotImageOverrides={
 "Smurf Cat":"../Smurf Cat.svg"
};
function brainrotImagePath(name){
 return brainrotImageOverrides[name]||`../${name}.webp`;
}
function multiplierNumber(value,fallback=0){
 const parsed=Number.parseFloat(String(value??"").replace(",","."));
 return Number.isFinite(parsed)?parsed:fallback;
}
function multiplierBounds(value,fallback=0){
 const values=(String(value??"").replaceAll(",",".").match(/\d+(?:\.\d+)?/g)||[])
  .map(Number)
  .filter(Number.isFinite);
 if(!values.length)return {min:fallback,max:fallback};
 return {min:Math.min(...values),max:Math.max(...values)};
}
function incomeRecord(name){
 return brainrotIncomeByName.get(String(name).toLowerCase())||null;
}
function formatIncome(value){
 if(!Number.isFinite(value))return "";
 const units=[
  ["Dc",1e33],["No",1e30],["Oc",1e27],["Sp",1e24],["Sx",1e21],
  ["Qi",1e18],["Qa",1e15],["T",1e12],["B",1e9],["M",1e6],["K",1e3]
 ];
 const unit=units.find(([,size])=>Math.abs(value)>=size);
 if(!unit)return `${Number(value.toFixed(2))}/s`;
 const scaled=value/unit[1];
 const digits=scaled>=100?1:scaled>=10?2:4;
 return `${Number(scaled.toFixed(digits))}${unit[0]}/s`;
}
function formatIncomeRange(min,max=min){
 return Math.abs(max-min)<1?formatIncome(min):`${formatIncome(min)}–${formatIncome(max)}`;
}
function brainrotIncomeCalculation(name,mutationValue=null,traitValues=[]){
 const base=incomeRecord(name);
 if(!base)return null;
 let mutationMultipliers={min:1,max:1};
 if(typeof mutationValue==="string"){
  mutationMultipliers=multiplierBounds(mutations.find(item=>item.name===mutationValue)?.multiplier,1);
 }else if(mutationValue){
  mutationMultipliers=multiplierBounds(mutationValue.multiplier,1);
 }
 const traitMultiplier=traitValues.reduce((total,traitValue)=>{
  const traitName=typeof traitValue==="string"?traitValue:traitValue?.name;
  const source=typeof traitValue==="object"&&traitValue?.multiplier
   ?traitValue
   :traits.find(item=>item.name===traitName);
  return total+multiplierNumber(source?.multiplier||source?.mult,0);
 },0);
 const totalMultiplier=mutationMultipliers.min+traitMultiplier;
 const totalMultiplierMax=mutationMultipliers.max+traitMultiplier;
 return {
  base:base.incomePerSecond,
  baseLabel:`${base.income}/s`,
  mutationMultiplier:mutationMultipliers.min,
  mutationMultiplierMax:mutationMultipliers.max,
  traitMultiplier,
  totalMultiplier,
  totalMultiplierMax,
  income:base.incomePerSecond*totalMultiplier,
  incomeMax:base.incomePerSecond*totalMultiplierMax
 };
}
function listingTotalIncome(item){
 const calculations=listingBrainrots(item).map(brainrot=>{
  const result=brainrotIncomeCalculation(brainrot.name,brainrot.mutation,brainrot.traits||[]);
  const quantity=brainrot.quantity||1;
  return result?{...result,income:result.income*quantity,incomeMax:result.incomeMax*quantity}:null;
 });
 return calculations.length&&calculations.every(Boolean)
  ?calculations.reduce((total,result)=>({min:total.min+result.income,max:total.max+result.incomeMax}),{min:0,max:0})
  :null;
}
const cards=document.querySelector("#cards"),resultCount=document.querySelector("#resultCount");
document.querySelector("#exchangeLoadMore")?.addEventListener("click",()=>void loadMoreExchangeListings());
const modes=x=>[x.cash!=null?"cash":null,x.brains!=null?"brains":null,x.stars!=null?"stars":null,x.trade?"trade":null].filter(Boolean);
const listingIntentOf=item=>item?.intent==="buy"?"buy":"sell";
function terms(x){
 const currency=cashCurrency(x),strict=cashCurrencyOnly(x);
 const cashLabel=strict?formatOriginalCashPrice(x.cash,currency):formatCashPrice(x.cash,currency);
 return `<div class="terms">${x.cash!=null?`<span class="term cash">${cashLabel}</span>${strict?`<span class="term currency-only">${t("currency_only_badge").toUpperCase()} ${currency}</span>`:""}`:""}${x.brains!=null?`<span class="term brains">🧠 ${x.brains}</span>`:""}${x.stars!=null?`<span class="term stars">★ ${formatNumber(x.stars)} XTR</span>`:""}${x.trade?`<span class="term trade">⇄ ${t("trade").toUpperCase()}</span>`:""}</div>`;
}
function listingBrainrots(item){
 const brainrots=item.brainrots?.length?item.brainrots:[{name:item.name,img:item.img,traits:[],quantity:1}];
 return brainrots.map(brainrot=>({
  ...brainrot,
  quantity:Math.max(1,Number.parseInt(brainrot.quantity,10)||1),
  img:brainrotImageOverrides[brainrot.name]||brainrot.img||brainrotImagePath(brainrot.name)
 }));
}
function filterInputValue(id){
 const value=document.querySelector(`#${id}`)?.value?.trim();
 if(value===""||value==null)return null;
 const number=Number(value);
 return Number.isFinite(number)?number:null;
}
function parseCompactIncome(value){
 const source=String(value??"").trim().replace(",",".").replace(/\s+/g,"");
 if(!source)return null;
 const match=source.match(/^(\d+(?:\.\d+)?)(k|m|b|t|qa|qi|sx|sp|oc|no|dc)?(?:\/s)?$/i);
 if(!match)return Number.NaN;
 const multipliers={k:1e3,m:1e6,b:1e9,t:1e12,qa:1e15,qi:1e18,sx:1e21,sp:1e24,oc:1e27,no:1e30,dc:1e33};
 return Number(match[1])*(multipliers[(match[2]||"").toLowerCase()]||1);
}
function listingSearchText(item){
 const brainrots=listingBrainrots(item);
 return [
  item.name,item.seller,item.trade,
  ...brainrots.flatMap(brainrot=>[
   brainrot.name,
   brainrot.mutation?.name,
   ...(brainrot.traits||[]).map(trait=>trait.name)
  ])
 ].filter(Boolean).join(" ").toLowerCase();
}
function listingTotalQuantity(item){
 return listingBrainrots(item).reduce((total,brainrot)=>total+(brainrot.quantity||1),0);
}
function numberInRange(value,min,max){
 if(min!=null&&(value==null||value<min))return false;
 if(max!=null&&(value==null||value>max))return false;
 return true;
}
function matchesExchangeFilters(item){
 const brainrots=listingBrainrots(item);
 if(exchangeFilters.intent!=="all"&&listingIntentOf(item)!==exchangeFilters.intent)return false;
 const query=document.querySelector("#search")?.value.trim().toLowerCase()||"";
 const seller=document.querySelector("#filterSeller")?.value.trim().toLowerCase()||"";
 if(query){
  const queryWords=query.split(/\s+/).filter(Boolean);
  const matches=exchangeFilters.exact
   ?brainrots.some(brainrot=>brainrot.name.toLowerCase()===query)
   :queryWords.every(word=>listingSearchText(item).includes(word));
  if(!matches)return false;
 }
 if(seller&&!String(item.seller||"").toLowerCase().includes(seller))return false;

 const itemModes=modes(item);
 if(exchangeFilters.methods.size){
  const selected=[...exchangeFilters.methods];
  const methodMatches=exchangeFilters.allMethods
   ?selected.every(method=>itemModes.includes(method))
   :selected.some(method=>itemModes.includes(method));
  if(!methodMatches)return false;
 }
 if(exchangeFilters.multipleMethods&&itemModes.length<2)return false;

 const distinctCount=brainrots.length;
 const totalQuantity=listingTotalQuantity(item);
 if(exchangeFilters.structure==="single"&&distinctCount!==1)return false;
 if(exchangeFilters.structure==="bundle"&&distinctCount<2)return false;
 if(!numberInRange(distinctCount,filterInputValue("filterItemsMin"),filterInputValue("filterItemsMax")))return false;
 if(!numberInRange(totalQuantity,filterInputValue("filterQuantityMin"),filterInputValue("filterQuantityMax")))return false;
 if(!numberInRange(item.brains,filterInputValue("filterBrainsMin"),filterInputValue("filterBrainsMax")))return false;
 if(!numberInRange(item.stars,filterInputValue("filterStarsMin"),filterInputValue("filterStarsMax")))return false;
 const selectedCashCurrency=document.querySelector("#filterCashCurrency")?.value||"";
 if(selectedCashCurrency&&(item.cash==null||cashCurrency(item)!==selectedCashCurrency))return false;
 if(exchangeFilters.strictCashCurrency&&(item.cash==null||!cashCurrencyOnly(item)))return false;
 const comparableCash=selectedCashCurrency?item.cash:cashValueInDisplayCurrency(item);
 if(!numberInRange(comparableCash,filterInputValue("filterCashMin"),filterInputValue("filterCashMax")))return false;

 const income=listingTotalIncome(item);
 const incomeMin=parseCompactIncome(document.querySelector("#filterIncomeMin")?.value);
 const incomeMax=parseCompactIncome(document.querySelector("#filterIncomeMax")?.value);
 if(Number.isNaN(incomeMin)||Number.isNaN(incomeMax))return false;
 if(incomeMin!=null&&(!income||income.max<incomeMin))return false;
 if(incomeMax!=null&&(!income||income.min>incomeMax))return false;

 const itemMutations=brainrots.map(brainrot=>brainrot.mutation?.name).filter(Boolean);
 const itemTraits=new Set(brainrots.flatMap(brainrot=>(brainrot.traits||[]).map(trait=>trait.name)));
 if(exchangeFilters.mutation&&!itemMutations.includes(exchangeFilters.mutation))return false;
 if(exchangeFilters.excludedMutation&&itemMutations.includes(exchangeFilters.excludedMutation))return false;
 if(exchangeFilters.traits.size){
  const selected=[...exchangeFilters.traits];
  const traitMatches=exchangeFilters.traitMode==="all"
   ?selected.every(name=>itemTraits.has(name))
   :selected.some(name=>itemTraits.has(name));
  if(!traitMatches)return false;
 }
 if([...exchangeFilters.excludedTraits].some(name=>itemTraits.has(name)))return false;
 if(exchangeFilters.noMutation&&itemMutations.length)return false;
 if(exchangeFilters.noTraits&&itemTraits.size)return false;
 if(exchangeFilters.hasMutation&&!itemMutations.length)return false;
 if(exchangeFilters.hasTraits&&!itemTraits.size)return false;
 if(exchangeFilters.screenshots&&!Number(item.screenshotCount||item.screenshots?.length||0))return false;
 return true;
}
function sortExchangeListings(list){
 const sort=document.querySelector("#sort")?.value||"new";
 const compareKnown=(a,b,getValue,direction=1)=>{
  const aValue=getValue(a),bValue=getValue(b);
  if(aValue==null&&bValue==null)return 0;
  if(aValue==null)return 1;
  if(bValue==null)return -1;
  return (aValue-bValue)*direction;
 };
 const brainsValue=item=>item.brains==null?null:Number(item.brains);
 const starsValue=item=>item.stars==null?null:Number(item.stars);
 const cashValue=item=>cashValueInRub(item);
 const incomeValue=item=>listingTotalIncome(item)?.max??null;
 if(sort==="income_desc")list.sort((a,b)=>compareKnown(a,b,incomeValue,-1));
 else if(sort==="income_asc")list.sort((a,b)=>compareKnown(a,b,incomeValue,1));
 else if(sort==="brains_asc")list.sort((a,b)=>compareKnown(a,b,brainsValue,1));
 else if(sort==="brains_desc")list.sort((a,b)=>compareKnown(a,b,brainsValue,-1));
 else if(sort==="stars_asc")list.sort((a,b)=>compareKnown(a,b,starsValue,1));
 else if(sort==="stars_desc")list.sort((a,b)=>compareKnown(a,b,starsValue,-1));
 else if(sort==="cash_asc")list.sort((a,b)=>compareKnown(a,b,cashValue,1));
 else if(sort==="cash_desc")list.sort((a,b)=>compareKnown(a,b,cashValue,-1));
 else if(sort==="quantity_desc")list.sort((a,b)=>listingTotalQuantity(b)-listingTotalQuantity(a));
 else if(sort==="offers")list.sort((a,b)=>offerCount(b)-offerCount(a));
 else list.sort((a,b)=>(Number(b.createdAt)||Number(b.id)||0)-(Number(a.createdAt)||Number(a.id)||0));
 return list;
}
function activeFilterEntries(){
 const entries=[];
 const inputEntry=(id,label,suffix="")=>{const value=document.querySelector(`#${id}`)?.value?.trim();if(value)entries.push({key:id,label:`${label}: ${value}${suffix}`})};
 const methodNames={trade:t("trade"),cash:t("sale"),brains:t("for_brains"),stars:"Telegram Stars"};
 if(exchangeFilters.intent!=="all")entries.push({key:"intent",label:exchangeFilters.intent==="buy"?"Хотят купить":"Продают"});
 exchangeFilters.methods.forEach(method=>entries.push({key:`method:${method}`,label:methodNames[method]}));
 if(exchangeFilters.allMethods)entries.push({key:"allMethods",label:t("require_all_methods")});
 const search=document.querySelector("#search")?.value?.trim();if(search)entries.push({key:"search",label:`⌕ ${search}`});
 const seller=document.querySelector("#filterSeller")?.value?.trim();if(seller)entries.push({key:"seller",label:seller});
 if(exchangeFilters.exact)entries.push({key:"exact",label:t("exact_item_match")});
 inputEntry("filterBrainsMin","🧠 min");inputEntry("filterBrainsMax","🧠 max");
 inputEntry("filterStarsMin","Stars min");inputEntry("filterStarsMax","Stars max");
 const filterCurrency=document.querySelector("#filterCashCurrency")?.value||displayCashCurrency;
 inputEntry("filterCashMin",`${filterCurrency} min`);inputEntry("filterCashMax",`${filterCurrency} max`);
 if(document.querySelector("#filterCashCurrency")?.value)entries.push({key:"filterCashCurrency",label:document.querySelector("#filterCashCurrency").value});
 inputEntry("filterIncomeMin","income min");inputEntry("filterIncomeMax","income max");
 inputEntry("filterItemsMin","items min");inputEntry("filterItemsMax","items max");
 inputEntry("filterQuantityMin","qty min");inputEntry("filterQuantityMax","qty max");
 if(exchangeFilters.structure!=="all")entries.push({key:"structure",label:exchangeFilters.structure==="single"?t("single_item"):t("bundle")});
 if(exchangeFilters.mutation)entries.push({key:"mutation",label:exchangeFilters.mutation});
 if(exchangeFilters.excludedMutation)entries.push({key:"excludedMutation",label:`${t("excluded_attributes")}: ${exchangeFilters.excludedMutation}`});
 exchangeFilters.traits.forEach(name=>entries.push({key:`trait:${name}`,label:name}));
 exchangeFilters.excludedTraits.forEach(name=>entries.push({key:`excludedTrait:${name}`,label:`${t("excluded_attributes")}: ${name}`}));
 if(exchangeFilters.screenshots)entries.push({key:"screenshots",label:t("with_screenshots")});
 if(exchangeFilters.hasMutation)entries.push({key:"hasMutation",label:t("with_mutation")});
 if(exchangeFilters.hasTraits)entries.push({key:"hasTraits",label:t("with_traits")});
 if(exchangeFilters.noMutation)entries.push({key:"noMutation",label:t("without_mutations")});
 if(exchangeFilters.noTraits)entries.push({key:"noTraits",label:t("without_traits")});
 if(exchangeFilters.strictCashCurrency)entries.push({key:"strictCashCurrency",label:t("strict_cash_currency")});
 if(exchangeFilters.multipleMethods)entries.push({key:"multipleMethods",label:t("multiple_methods")});
 return entries;
}
function clearExchangeFilter(key){
 if(key.startsWith("method:"))exchangeFilters.methods.delete(key.slice(7));
 else if(key.startsWith("trait:"))exchangeFilters.traits.delete(key.slice(6));
 else if(key.startsWith("excludedTrait:"))exchangeFilters.excludedTraits.delete(key.slice(14));
 else if(key==="search")document.querySelector("#search").value="";
 else if(key==="seller")document.querySelector("#filterSeller").value="";
 else if(key==="structure")exchangeFilters.structure="all";
 else if(key==="intent")exchangeFilters.intent="all";
 else if(key==="mutation")exchangeFilters.mutation="";
 else if(key==="excludedMutation")exchangeFilters.excludedMutation="";
 else if(key in exchangeFilters)exchangeFilters[key]=false;
 else{const input=document.querySelector(`#${key}`);if(input)input.value=""}
 syncExchangeFilterControls();
 render();
}
function syncExchangeFilterControls(){
 document.querySelectorAll("[data-filter-method]").forEach(input=>{input.checked=exchangeFilters.methods.has(input.dataset.filterMethod)});
 const toggleMap={filterAllMethods:"allMethods",filterExact:"exact",filterScreenshots:"screenshots",filterHasMutation:"hasMutation",filterHasTraits:"hasTraits",filterNoMutation:"noMutation",filterNoTraits:"noTraits",filterStrictCashCurrency:"strictCashCurrency",filterMultipleMethods:"multipleMethods"};
 Object.entries(toggleMap).forEach(([id,key])=>{const input=document.querySelector(`#${id}`);if(input)input.checked=exchangeFilters[key]});
 document.querySelectorAll("[data-structure]").forEach(button=>button.classList.toggle("active",button.dataset.structure===exchangeFilters.structure));
 document.querySelectorAll("[data-filter-intent]").forEach(button=>button.classList.toggle("active",button.dataset.filterIntent===exchangeFilters.intent));
 document.querySelectorAll("[data-trait-mode]").forEach(button=>button.classList.toggle("active",button.dataset.traitMode===exchangeFilters.traitMode));
 document.querySelectorAll("[data-trait-selection-mode]").forEach(button=>button.classList.toggle("active",button.dataset.traitSelectionMode===exchangeFilters.traitSelectionMode));
 const mutation=document.querySelector("#filterMutation");if(mutation)mutation.value=exchangeFilters.mutation;
 const excludedMutation=document.querySelector("#filterExcludedMutation");if(excludedMutation)excludedMutation.value=exchangeFilters.excludedMutation;
 const traitMatchMode=document.querySelector("#traitMatchMode");if(traitMatchMode)traitMatchMode.classList.toggle("hidden",exchangeFilters.traitSelectionMode!=="include");
 renderFilterTraitOptions();
}
function resetExchangeFilters(){
 exchangeFilters.methods.clear();
 exchangeFilters.traits.clear();
 exchangeFilters.excludedTraits.clear();
 Object.assign(exchangeFilters,{intent:"all",allMethods:false,structure:"all",mutation:"",excludedMutation:"",traitMode:"any",traitSelectionMode:"include",exact:false,screenshots:false,hasMutation:false,hasTraits:false,noMutation:false,noTraits:false,strictCashCurrency:false,multipleMethods:false});
 ["search","filterSeller","filterBrainsMin","filterBrainsMax","filterStarsMin","filterStarsMax","filterCashMin","filterCashMax","filterIncomeMin","filterIncomeMax","filterItemsMin","filterItemsMax","filterQuantityMin","filterQuantityMax","filterTraitSearch","filterCashCurrency"].forEach(id=>{const input=document.querySelector(`#${id}`);if(input)input.value=""});
 document.querySelector("#sort").value="new";
 syncExchangeFilterControls();
 render();
}
function renderFilterMutationOptions(){
 const options=mutations.map(mutation=>`<option value="${escapeHtml(mutation.name)}">${escapeHtml(mutation.name)} · ${escapeHtml(mutation.multiplier||"")}</option>`).join("");
 const select=document.querySelector("#filterMutation");
 if(select){select.innerHTML=`<option value="">${t("any_mutation")}</option>${options}`;select.value=exchangeFilters.mutation}
 const excluded=document.querySelector("#filterExcludedMutation");
 if(excluded){excluded.innerHTML=`<option value="">${t("any_forbidden_mutation")}</option>${options}`;excluded.value=exchangeFilters.excludedMutation}
}
function renderFilterTraitOptions(){
 const container=document.querySelector("#filterTraitOptions");
 const selected=document.querySelector("#selectedFilterTraits");
 if(!container||!selected)return;
 const query=document.querySelector("#filterTraitSearch")?.value.trim().toLowerCase()||"";
 const visible=traits.filter(trait=>!query||trait.name.toLowerCase().includes(query));
 container.innerHTML=visible.map(trait=>{
  const required=exchangeFilters.traits.has(trait.name),excluded=exchangeFilters.excludedTraits.has(trait.name);
  const state=required?"required":excluded?"excluded":"";
  return `<button class="filter-trait-option ${state}" type="button" data-filter-trait="${encodeURIComponent(trait.name)}"><img src="${escapeHtml(trait.image)}" alt=""><span>${escapeHtml(trait.name)}</span><i>${excluded?"−":"✓"}</i></button>`;
 }).join("");
 selected.classList.toggle("hidden",exchangeFilters.traits.size===0&&exchangeFilters.excludedTraits.size===0);
 const requiredChips=[...exchangeFilters.traits].map(name=>{const trait=traits.find(item=>item.name===name);return `<button type="button" data-remove-filter-trait="${encodeURIComponent(name)}">${trait?`<img src="${escapeHtml(trait.image)}" alt="">`:""}<span>✓ ${escapeHtml(name)}</span> ×</button>`}).join("");
 const excludedChips=[...exchangeFilters.excludedTraits].map(name=>{const trait=traits.find(item=>item.name===name);return `<button class="excluded" type="button" data-remove-excluded-trait="${encodeURIComponent(name)}">${trait?`<img src="${escapeHtml(trait.image)}" alt="">`:""}<span>− ${escapeHtml(name)}</span> ×</button>`}).join("");
 selected.innerHTML=requiredChips+excludedChips;
 container.querySelectorAll("[data-filter-trait]").forEach(button=>button.onclick=()=>{
  const name=decodeURIComponent(button.dataset.filterTrait);
  if(exchangeFilters.traitSelectionMode==="exclude"){
   exchangeFilters.traits.delete(name);
   if(exchangeFilters.excludedTraits.has(name))exchangeFilters.excludedTraits.delete(name);else exchangeFilters.excludedTraits.add(name);
  }else{
   exchangeFilters.excludedTraits.delete(name);
   exchangeFilters.noTraits=false;
   if(exchangeFilters.traits.has(name))exchangeFilters.traits.delete(name);else exchangeFilters.traits.add(name);
  }
  syncExchangeFilterControls();render();
 });
 selected.querySelectorAll("[data-remove-filter-trait]").forEach(button=>button.onclick=()=>{
  exchangeFilters.traits.delete(decodeURIComponent(button.dataset.removeFilterTrait));
  renderFilterTraitOptions();render();
 });
 selected.querySelectorAll("[data-remove-excluded-trait]").forEach(button=>button.onclick=()=>{
  exchangeFilters.excludedTraits.delete(decodeURIComponent(button.dataset.removeExcludedTrait));
  renderFilterTraitOptions();render();
 });
}
function renderFilterStatus(matchCount){
 const entries=activeFilterEntries();
 const chips=document.querySelector("#activeFilterChips");
 if(chips){
  chips.classList.toggle("hidden",entries.length===0);
  chips.innerHTML=entries.map(entry=>`<button type="button" data-clear-filter="${encodeURIComponent(entry.key)}"><span>${escapeHtml(entry.label)}</span><i>×</i></button>`).join("");
  chips.querySelectorAll("[data-clear-filter]").forEach(button=>button.onclick=()=>clearExchangeFilter(decodeURIComponent(button.dataset.clearFilter)));
 }
 ["filterMatchCount","applyFilterCount"].forEach(id=>{const node=document.querySelector(`#${id}`);if(node)node.textContent=matchCount});
 const badge=document.querySelector("#mobileFilterCount");
 if(badge){badge.textContent=entries.length;badge.classList.toggle("hidden",entries.length===0)}
}
function listingMedia(item,variant="card"){
 const brainrots=listingBrainrots(item);
 const columns=brainrots.length===1?1:2;
 const rows=Math.ceil(brainrots.length/columns);
 return `<div class="listing-media ${variant} count-${brainrots.length}" style="--listing-columns:${columns};--listing-rows:${rows}">${brainrots.map(brainrot=>`
  <div class="listing-brainrot-visual ${brainrot.mutation||brainrot.traits?.length?"has-attributes":"no-attributes"}">
   ${variant==="detail"?`<span class="listing-brainrot-name" title="${escapeHtml(brainrot.name)}">${escapeHtml(brainrot.name)}${brainrot.quantity>1?` ×${brainrot.quantity}`:""}</span>`:""}
   <img class="brainrot-image" src="${escapeHtml(brainrot.img)}" alt="${escapeHtml(brainrot.name)}">
   ${brainrot.mutation||brainrot.traits?.length?`<div class="listing-attribute-rack">
    ${brainrot.mutation?`<div class="listing-mutation-icon"><img src="${escapeHtml(brainrot.mutation.image)}" alt="${escapeHtml(brainrot.mutation.name)}" title="${escapeHtml(brainrot.mutation.name)} · ${escapeHtml(brainrot.mutation.multiplier)}"><b>${escapeHtml(brainrot.mutation.name)}</b></div>`:""}
    ${brainrot.traits?.length?`<div class="listing-trait-icons">${brainrot.traits.map(trait=>`<span><img src="${escapeHtml(trait.image)}" alt="${escapeHtml(trait.name)}" title="${escapeHtml(trait.name)}"><b>${escapeHtml(trait.name)}</b></span>`).join("")}</div>`:""}
   </div>`:""}
   ${brainrot.quantity>1?`<span class="listing-quantity">×${brainrot.quantity}</span>`:""}
   ${(()=>{const result=brainrotIncomeCalculation(brainrot.name,brainrot.mutation,brainrot.traits||[]),quantity=brainrot.quantity||1;return result?`<strong class="listing-income">${formatIncomeRange(result.income*quantity,result.incomeMax*quantity)}</strong>`:""})()}
  </div>`).join("")}</div>`;
}
function listingAttributeIcons(item){
 const icons=listingBrainrots(item).flatMap(brainrot=>[
  brainrot.mutation?{...brainrot.mutation,type:"mutation"}:null,
  ...(brainrot.traits||[]).map(trait=>({...trait,type:"trait"}))
 ]).filter(Boolean);
 return icons.length?`<div class="listing-cover-attributes">${icons.map(icon=>`<img class="${icon.type}" src="${icon.image}" alt="${icon.name}" title="${icon.name}${icon.multiplier?` · ${icon.multiplier}`:""}">`).join("")}</div>`:"";
}
function listingCoverLoadout(item){
 const brainrots=listingBrainrots(item);
 return `<div class="listing-cover-loadout">${brainrots.map(brainrot=>{
  const attributes=[
   brainrot.mutation?{...brainrot.mutation,type:"mutation"}:null,
   ...(brainrot.traits||[]).map(trait=>({...trait,type:"trait"}))
  ].filter(Boolean);
  const income=brainrotIncomeCalculation(brainrot.name,brainrot.mutation,brainrot.traits||[]);
  const quantity=brainrot.quantity||1;
  return `<div class="cover-loadout-row">
   <img class="cover-loadout-thumb" src="${brainrot.img}" alt="">
   <span class="cover-loadout-copy">
    <span class="cover-loadout-title">
     <b title="${brainrot.name}">${brainrot.name}${brainrot.quantity>1?` ×${brainrot.quantity}`:""}</b>
     ${income?`<strong>${formatIncomeRange(income.income*quantity,income.incomeMax*quantity)}</strong>`:""}
    </span>
    <i>${attributes.length
     ?attributes.slice(0,4).map(attribute=>`<img class="${attribute.type}" src="${attribute.image}" alt="${attribute.name}" title="${attribute.name}${attribute.multiplier?` · ${attribute.multiplier}`:""}">`).join("")
     :`<small>без бафов</small>`}${attributes.length>4?`<em>+${attributes.length-4}</em>`:""}</i>
   </span>
  </div>`;
 }).join("")}</div>`;
}
function listingPreview(item){
 if(!item.screenshots?.length)return listingMedia(item,"card");
 const shot=item.screenshots[0];
 const totalIncome=listingTotalIncome(item);
 const brainrots=listingBrainrots(item);
 const grouped=brainrots.length>1;
 return `<div class="listing-cover-shot ${grouped?"with-loadout":""} items-${brainrots.length}">
  <div class="cover-photo-stage">
   <img class="cover-backdrop" src="${escapeHtml(shot.url)}" alt="" aria-hidden="true">
   <img class="cover-image" src="${escapeHtml(shot.url)}" alt="${escapeHtml(shot.name)}">
   ${grouped?"":listingAttributeIcons(item)}
   ${!grouped&&totalIncome?`<em class="listing-cover-income">${formatIncomeRange(totalIncome.min,totalIncome.max)}</em>`:""}
   <span>${t("seller_photo")}</span>
   ${item.screenshots.length>1?`<b>+${item.screenshots.length-1}</b>`:""}
  </div>
  ${grouped?listingCoverLoadout(item):""}
 </div>`;
}
function listingScreenshots(item){
 if(!item.screenshots?.length)return "";
 return `<section class="listing-screenshot-gallery"><div class="section-caption">${t("screenshots")}</div><div>${item.screenshots.map((shot,index)=>`<button type="button" data-view-shot="${index}" title="${escapeHtml(shot.name)}"><img src="${escapeHtml(shot.url)}" alt="${escapeHtml(shot.name)}"></button>`).join("")}</div></section>`;
}
let screenshotViewerItem=null,screenshotViewerIndex=0;
function openScreenshotViewer(item,index=0){
 if(!item?.screenshots?.length)return;
 screenshotViewerItem=item;
 screenshotViewerIndex=Math.max(0,Math.min(index,item.screenshots.length-1));
 renderScreenshotViewer();
 document.querySelector("#screenshotViewer").classList.remove("hidden");
}
function closeScreenshotViewer(){
 document.querySelector("#screenshotViewer").classList.add("hidden");
 screenshotViewerItem=null;
}
function moveScreenshotViewer(step){
 if(!screenshotViewerItem?.screenshots?.length)return;
 screenshotViewerIndex=(screenshotViewerIndex+step+screenshotViewerItem.screenshots.length)%screenshotViewerItem.screenshots.length;
 renderScreenshotViewer();
}
function renderScreenshotViewer(){
 if(!screenshotViewerItem)return;
 const shots=screenshotViewerItem.screenshots,shot=shots[screenshotViewerIndex];
 document.querySelector("#screenshotViewerImage").src=shot.url;
 document.querySelector("#screenshotViewerImage").alt=shot.name;
 document.querySelector("#screenshotViewerName").textContent=shot.name;
 document.querySelector("#screenshotViewerCounter").textContent=`${t("photo_of")} ${screenshotViewerIndex+1} / ${shots.length}`;
 document.querySelector("#screenshotViewerPrev").classList.toggle("hidden",shots.length<2);
 document.querySelector("#screenshotViewerNext").classList.toggle("hidden",shots.length<2);
}
function offerCount(item){
 const submitted=chatThreads.filter(thread=>thread.itemId===item.id&&thread.id!=="thread-demo").length;
 return (Number(item.offers)||0)+submitted;
}
function formatOfferCount(count){
 if(language!=="ru")return `${count} ${t("offers")}`;
 const mod10=count%10,mod100=count%100;
 const word=mod10===1&&mod100!==11?"предложение":mod10>=2&&mod10<=4&&(mod100<12||mod100>14)?"предложения":"предложений";
 return `${count} ${word}`;
}
function render(){
 const existingItems=items.filter(item=>!deletedListingIds.has(item.id)&&item.status!=="sold");
 const publishedItems=existingItems.filter(item=>item.status==="active"&&!pausedListingIds.has(item.id)&&!restrictedSellers.has(item.seller)&&!blockedUserIds.has(Number(item.seller_tg_id)));
 const setCount=(selector,value)=>{const node=document.querySelector(selector);if(node)node.textContent=value};
 setCount('.tab[data-tab="market"] b',exchangeListingPage.total||publishedItems.length);
 setCount('.tab[data-tab="wanted"] b',publishedItems.filter(item=>Boolean(item.trade)).length);
 setCount("#tradeFilterCount",publishedItems.filter(item=>Boolean(item.trade)).length);
 setCount("#cashFilterCount",publishedItems.filter(item=>item.cash!=null).length);
 setCount("#brainsFilterCount",publishedItems.filter(item=>item.brains!=null).length);
 setCount("#starsFilterCount",publishedItems.filter(item=>item.stars!=null).length);
 const sourceItems=activeTab==="mine"?existingItems.filter(item=>item.seller===currentAccount.username):publishedItems;
 let list=sourceItems.filter(matchesExchangeFilters);
 sortExchangeListings(list);
 const visibleCount=activeTab==="market"&&exchangeListingPage.total>list.length
  ?`${list.length} / ${exchangeListingPage.total}`
  :`${list.length}`;
 resultCount.textContent=`${visibleCount} ${t("offers")}`;
 const mobileResultCount=document.querySelector("#mobileResultCount");
 if(mobileResultCount)mobileResultCount.textContent=`${visibleCount} ${t("offers")}`;
 renderFilterStatus(list.length);
 cards.classList.toggle("is-empty",list.length===0);
 cards.innerHTML=list.length?list.map(x=>{const hidden=pausedListingIds.has(x.id),reserved=x.status==="reserved",moderated=restrictedSellers.has(x.seller),sellerReserve=Number(x.sellerReservedBrains||0),intent=listingIntentOf(x);return `<article class="card intent-${intent} ${x.id===selectedId?"selected":""} ${hidden||reserved||moderated?"inactive-listing":""}" data-id="${x.id}">
  <div class="card-top"><div><div class="listing-title-line"><span class="listing-intent-badge ${intent}">${intent==="buy"?"ХОЧУ КУПИТЬ":"ПРОДАЮ"}</span><h3>${escapeHtml(x.name)}</h3></div><button class="seller public-profile-link" type="button" data-public-profile="${Number(x.seller_tg_id)||0}">${escapeHtml(x.seller)}</button>${sellerReserve?`<span class="public-reserve"><i>◆</i>${formatNumber(sellerReserve)} 🧠 в резерве</span>`:""}</div><span class="card-statuses">${hidden?`<i class="listing-state hidden-state">СКРЫТО</i>`:""}${reserved?`<i class="listing-state reserved-state">В СДЕЛКЕ</i>`:""}${moderated?`<i class="listing-state moderated-state">МОДЕРАЦИЯ</i>`:""}${x.seller===currentAccount.username?`<span class="own-badge">${t("own")}</span>`:""}</span></div>
  <div class="item-photo">${listingPreview(x)}</div>
  <div class="card-bottom"><div>${terms(x)}</div><span class="seller">${formatOfferCount(offerCount(x))}</span></div>
 </article>`}).join(""):`<div class="exchange-empty-market"><div class="exchange-empty-market-card"><div class="exchange-empty-market-mark">◎</div><h3>${activeTab==="mine"?"У тебя пока нет объявлений":"Предложений пока нет"}</h3><p>${activeTab==="mine"?"Создай первое объявление — добавь предмет, выбери способы сделки и укажи условия.":"Новые предложения появятся здесь автоматически. Ты можешь создать своё прямо сейчас."}</p><button class="primary" id="emptyMarketCreate" type="button">＋ Создать предложение</button></div></div>`;
 document.querySelectorAll(".card").forEach(c=>c.onclick=()=>openDeal(+c.dataset.id));
 document.querySelector("#emptyMarketCreate")?.addEventListener("click",()=>document.querySelector("#createBtn")?.click());
 document.querySelectorAll("[data-public-profile]").forEach(button=>button.onclick=event=>{event.stopPropagation();openPublicProfile(+button.dataset.publicProfile)});
 const loadMore=document.querySelector("#exchangeLoadMore");
 if(loadMore){
  loadMore.classList.toggle("hidden",activeTab!=="market"||!exchangeListingPage.hasMore);
  loadMore.disabled=exchangeLoadingMore;
  loadMore.textContent=exchangeLoadingMore?"Загрузка...":"Показать ещё";
 }
}
function dealContextKey(id){return `${currentAccount.username}:${id}`}
function escapeHtml(value){
 return String(value??"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
}
function openPublicProfile(targetId){
 const numericTarget=Number(targetId);
 if(!Number.isSafeInteger(numericTarget)||numericTarget<=0)return;
 window.parent.postMessage({type:"brainbet-open-public-profile",targetId:numericTarget},exchangeEmbeddingOrigin);
}
function methodDetails(mode,x){
 x=x||{};
 if(mode==="cash"){
 const currency=cashCurrency(x);
  if(cashCurrencyOnly(x)){
   const converted=currency!==displayCashCurrency?formatCashPrice(x.cash,currency):"";
   return {icon:cashCurrencies[currency].symbol,title:t("cash_method"),value:`${formatOriginalCashPrice(x.cash,currency)}${converted?` · ≈ ${converted}`:""}`,notice:`${t("currency_only_badge")} ${currency}`};
  }
  const equivalent=currency!==displayCashCurrency
   ?` · ${formatOriginalCashPrice(x.cash,currency)}`
   :"";
  return {icon:cashCurrencies[displayCashCurrency].symbol,title:t("cash_method"),value:`${formatCashPrice(x.cash,currency)}${equivalent}`};
 }
 if(mode==="brains")return {icon:"🧠",title:t("brains_method"),value:`${x.brains} ${t("brains_word")}`};
 if(mode==="stars")return {icon:"★",title:language==="ru"?"Telegram Stars":"Telegram Stars",value:`${formatNumber(x.stars)} XTR`};
 return {icon:"⇄",title:t("trade_method"),value:escapeHtml(x.trade||t("consider_offers"))};
}
function listingMethodDetails(mode,item){
 const details=methodDetails(mode,item);
 if(listingIntentOf(item)!=="buy")return details;
 const titles={cash:"Продать за деньги",brains:"Продать за мозги",stars:"Продать за Telegram Stars",trade:"Предложить обмен"};
 return {...details,title:titles[mode]||details.title};
}
function viewerThreadForListing(item){
 const viewerId=Number(currentAccount.tg_id);
 return chatThreads.find(thread=>thread.itemId===item.id&&(
  Number(thread.buyer_tg_id)===viewerId||Number(thread.seller_tg_id)===viewerId
 ));
}
function openDeal(id){
 if(deletedListingIds.has(id))return;
 selectedId=id;
 document.querySelector("#dealPanel")?.classList.add("mobile-open");
 document.body.classList.add("mobile-panel-visible","deal-view-open");
 closeExchangeTools();
 const x=items.find(item=>item.id===id);
 if(!x)return;
 if(x.compact){
  document.querySelector("#emptyDeal").classList.add("hidden");
  const loadingBox=document.querySelector("#dealContent");
  loadingBox.classList.remove("hidden");
  loadingBox.innerHTML='<div class="exchange-detail-loading">Загрузка объявления...</div>';
  void loadExchangeListingDetail(id).then(()=>{
   if(Number(selectedId)===Number(id))openDeal(id);
  }).catch(error=>{
   console.error("exchange listing detail",error);
   if(Number(selectedId)===Number(id))loadingBox.innerHTML='<div class="exchange-detail-loading error">Не удалось загрузить объявление</div>';
  });
  return;
 }
 const isOwner=x.seller===currentAccount.username;
 const canManage=isOwner;
 const contextKey=dealContextKey(id);
 const intent=listingIntentOf(x);
 const existingThread=!isOwner?viewerThreadForListing(x):null;
 const selectedMode=existingThread?.mode||dealSelections.get(contextKey)||null;
 if(selectedMode)dealSelections.set(contextKey,selectedMode);
 document.querySelector("#emptyDeal").classList.add("hidden");
 const box=document.querySelector("#dealContent");
 box.classList.remove("hidden");
 const availableMethods=[
  x.cash!=null?{mode:"cash",...listingMethodDetails("cash",x)}:null,
  x.brains!=null?{mode:"brains",...listingMethodDetails("brains",x)}:null,
  x.stars!=null?{mode:"stars",...listingMethodDetails("stars",x)}:null,
  x.trade?{mode:"trade",...listingMethodDetails("trade",x)}:null
 ].filter(Boolean);
 const choices=canManage
  ?x.status==="reserved"
   ?`<div class="listing-reserved-note"><b>ОБЪЯВЛЕНИЕ В СДЕЛКЕ</b><small>Карточка скрыта от покупателей. Редактирование вернётся после отмены сделки.</small></div>
    <button class="open-listing-chats" id="openListingChats"><span>✉</span><b>${t("open_chats")}</b><i>${threadsForItem(id).length}</i></button>`
   :`<details class="deal-disclosure owner-control-disclosure">
      <summary><span><i>⚙</i><b>Управление объявлением</b></span><em>Открыть</em></summary>
      <div class="owner-tools ${currentAccount.isAdmin&&!isOwner?"admin-owner-tools":""}"><button id="editListing">${t("edit")}</button><button id="pauseListing">${pausedListingIds.has(x.id)?"Вернуть":"Скрыть"}</button>${currentAccount.isAdmin?`<button class="danger" id="deleteListing">Удалить</button>`:""}</div>
     </details>
    <button class="open-listing-chats" id="openListingChats"><span>✉</span><b>${t("open_chats")}</b><i>${threadsForItem(id).length}</i></button>`
  :`<section class="purchase-methods">
    <div class="section-caption">${intent==="buy"?"ВЫБЕРИ, КАК ОТКЛИКНУТЬСЯ":t("choose_payment")}</div>
    ${availableMethods.map(method=>`<button class="purchase-method ${selectedMode===method.mode?"active":""} ${existingThread&&selectedMode!==method.mode?"locked":""}" data-deal-mode="${method.mode}" aria-pressed="${selectedMode===method.mode}" ${existingThread&&selectedMode!==method.mode?"disabled":""}>
      <span class="method-icon">${method.icon}</span>
      <span class="method-copy"><b>${method.title}</b><small>${method.value}</small>${method.notice?`<em class="method-currency-lock">${method.notice}</em>`:""}</span>
      <span class="method-radio"><i></i></span>
    </button>`).join("")}
    ${existingThread?`<div class="fixed-method-note"><b>✓ ${t("method_fixed")}</b><small>${t("change_in_chat")}</small></div><button class="open-existing-chat" id="openExistingChat" type="button">✉ ${t("open_chat")}</button>`:""}
   </section>`;
 box.innerHTML=`<div class="deal-title"><div><div class="kicker">OFFER #${String(x.id).padStart(4,"0")} · ${intent==="buy"?"ХОЧУ КУПИТЬ":"ПРОДАЮ"}</div><h2>${escapeHtml(x.name)}</h2><div class="deal-seller-trust"><button class="seller public-profile-link" type="button" data-public-profile="${Number(x.seller_tg_id)||0}">${escapeHtml(x.seller)}</button>${Number(x.sellerReservedBrains||0)?`<span class="public-reserve detail"><i>◆</i>${formatNumber(x.sellerReservedBrains)} 🧠 · РЕЗЕРВ</span>`:""}</div></div></div>
  <div class="deal-hero">${listingMedia(x,"detail")}</div>${terms(x)}${x.screenshots?.length?`<details class="deal-disclosure screenshot-disclosure"><summary><span><i>▣</i><b>${intent==="buy"?"Скриншоты покупателя":"Скриншоты продавца"}</b></span><em>${x.screenshots.length}</em></summary>${listingScreenshots(x)}</details>`:""}
 <div class="deal-options">${choices}</div>`;
 document.querySelectorAll("#dealContent [data-public-profile]").forEach(button=>button.onclick=()=>openPublicProfile(+button.dataset.publicProfile));
 document.querySelectorAll("[data-view-shot]").forEach(button=>button.onclick=()=>openScreenshotViewer(x,+button.dataset.viewShot));
 document.querySelectorAll("[data-deal-mode]").forEach(button=>button.onclick=()=>{
  dealSelections.set(contextKey,button.dataset.dealMode);
  startConversation(x,button.dataset.dealMode);
 });
 const openExistingChat=document.querySelector("#openExistingChat");if(openExistingChat)openExistingChat.onclick=()=>openMessenger(existingThread.id);
 const openChats=document.querySelector("#openListingChats");if(openChats)openChats.onclick=()=>{adminAllChatsMode=Boolean(currentAccount.isAdmin);openMessenger((adminAllChatsMode?chatThreads:threadsForItem(id)).find(thread=>thread.itemId===id)?.id||null)};
 const pause=document.querySelector("#pauseListing");if(pause)pause.onclick=()=>toggleListingPause(x);
 const edit=document.querySelector("#editListing");if(edit)edit.onclick=()=>beginListingEdit(x);
 const remove=document.querySelector("#deleteListing");if(remove)remove.onclick=()=>adminDeleteListing(x);
 render();
}
function threadViewerRole(thread){
 const viewerId=Number(currentAccount.tg_id);
 if(viewerId===Number(thread?.buyer_tg_id))return "buyer";
 if(viewerId===Number(thread?.seller_tg_id))return "seller";
 if(viewerId&&viewerId===Number(thread?.deal?.guarantorTgId))return "guarantor";
 return "";
}
function visibleThreads(){
 if(adminAllChatsMode&&currentAccount.isAdmin)return [...chatThreads].sort((a,b)=>b.updatedAt-a.updatedAt);
 return chatThreads.filter(thread=>Boolean(threadViewerRole(thread))).sort((a,b)=>b.updatedAt-a.updatedAt);
}
function threadsForItem(itemId){return visibleThreads().filter(thread=>thread.itemId===itemId)}
function threadPartner(thread){
 const role=threadViewerRole(thread);
 return adminAllChatsMode&&currentAccount.isAdmin||role==="guarantor"
  ?`${thread.buyer} ↔ ${thread.seller}`
  :role==="buyer"?thread.seller:thread.buyer;
}
function threadPartnerId(thread){
 if(!thread||adminAllChatsMode&&currentAccount.isAdmin)return 0;
 const role=threadViewerRole(thread);
 if(role==="buyer")return Number(thread.seller_tg_id);
 if(role==="seller")return Number(thread.buyer_tg_id);
 return 0;
}
function threadMessageIdentity(thread,message){
 const authorId=Number(message?.author_tg_id||0);
 if(!authorId)return "";
 return message.author||"";
}
function threadMessageRole(thread,message){
 const authorId=Number(message?.author_tg_id||0);
 if(authorId===Number(thread?.buyer_tg_id))return "buyer";
 if(authorId===Number(thread?.seller_tg_id))return "seller";
 if(authorId===Number(thread?.deal?.guarantorTgId))return "guarantor";
 return "admin";
}
function threadPresence(thread){
 const role=threadViewerRole(thread);
 if(role==="buyer")return {online:Boolean(thread.sellerOnline),label:thread.sellerOnline?t("online"):(language==="ru"?"не в сети":"offline")};
 if(role==="seller")return {online:Boolean(thread.buyerOnline),label:thread.buyerOnline?t("online"):(language==="ru"?"не в сети":"offline")};
 const count=Number(Boolean(thread.buyerOnline))+Number(Boolean(thread.sellerOnline));
 return {
  online:count>0,
  label:language==="ru"?(count===2?"оба в сети":count===1?"1 из 2 в сети":"оба не в сети"):(count===2?"both online":count===1?"1 of 2 online":"both offline")
 };
}
function renderThreadMessage(thread,message){
 if(message.author==="system")return `<div class="message-system">${escapeHtml(message.text)}<small>${message.time}</small></div>`;
 const mine=Number(message.author_tg_id)===Number(currentAccount.tg_id);
 const role=threadMessageRole(thread,message);
 let receipt="";
 if(mine){
  const read=Boolean(message.readByCounterparty),count=Number(message.readByCount||0),total=Number(message.readByTotal||1);
  const label=total>1
   ?(read?`✓✓ ${count}/${total}`:count?`✓✓ ${count}/${total}`:"✓")
   :(read?(language==="ru"?"✓✓ Прочитано":"✓✓ Read"):(language==="ru"?"✓ Отправлено":"✓ Sent"));
  receipt=`<span class="message-receipt ${read?"read":"sent"}">${label}</span>`;
 }
 return `<div class="message-row ${mine?"mine":""}"><div class="message-bubble">${mine?"":`<b class="message-author role-${role}" title="${role}">${escapeHtml(threadMessageIdentity(thread,message))}</b>`}<span class="message-text">${escapeHtml(message.text)}</span><small class="message-meta"><time>${message.time}</time>${receipt}</small></div></div>`;
}
function threadItem(thread){return items.find(item=>item.id===thread.itemId)}
function listingAvailability(item){
 if(!item)return {valid:false,label:"ОБЪЯВЛЕНИЕ УДАЛЕНО",detail:"Карточка больше не существует"};
 if(deletedListingIds.has(item.id))return {valid:false,label:"ОБЪЯВЛЕНИЕ УДАЛЕНО",detail:"Продавец или администратор удалил карточку"};
 if(pausedListingIds.has(item.id))return {valid:false,label:"ОБЪЯВЛЕНИЕ СКРЫТО",detail:"Карточка снята с публикации"};
 if(item.status==="reserved")return {valid:false,label:"ОБЪЯВЛЕНИЕ ЗАРЕЗЕРВИРОВАНО",detail:"По этой карточке уже идёт безопасная сделка"};
 if(item.status==="sold")return {valid:false,label:"ОБЪЯВЛЕНИЕ ЗАКРЫТО",detail:"Сделка завершена, карточка снята с публикации"};
 if(restrictedSellers.has(item.seller))return {valid:false,label:"ОБЪЯВЛЕНИЕ СКРЫТО МОДЕРАЦИЕЙ",detail:"Публикации продавца временно ограничены"};
 return {valid:true,label:"",detail:""};
}
function notifyListingThreads(item,text){
 const related=chatThreads.filter(thread=>thread.itemId===item.id);
 if(!related.length)return;
 related.forEach(thread=>{thread.messages.push({author:"system",text,time:currentTime()});thread.updatedAt=Date.now()});
 saveChatThreads();
}
async function startConversation(item,mode){
 let thread=viewerThreadForListing(item);
 if(thread){
  dealSelections.set(dealContextKey(item.id),thread.mode);
  if(selectedId===item.id)openDeal(item.id);
  openMessenger(thread.id);
  return;
 }
 try{
  const data=await exchangeFetch("/api/exchange/threads",{
   method:"POST",body:JSON.stringify({listing_id:item.id,method:mode})
  });
  thread=replaceThread(data.thread);
  dealSelections.set(dealContextKey(item.id),thread.mode);
  if(selectedId===item.id)openDeal(item.id);
  openMessenger(thread.id);
 }catch(error){alert(`Не удалось открыть чат: ${error.message}`)}
}
function currentTime(){return new Date().toLocaleTimeString(language==="ru"?"ru-RU":"en-US",{hour:"2-digit",minute:"2-digit"})}
function renderChatBadge(){
 const unread=chatThreads.reduce((total,thread)=>{
  if(!threadViewerRole(thread))return total;
  return total+(Number(thread.unreadCount)||((thread.unread||thread.unreadFor.includes(currentAccount.username))?1:0));
 },0);
 const badge=document.querySelector("#chatBadge");
 badge.textContent=unread;
 badge.classList.toggle("hidden",unread===0);
 const mobileBadge=document.querySelector("#mobileChatBadge");
 if(mobileBadge){
  mobileBadge.textContent=unread;
  mobileBadge.classList.toggle("hidden",unread===0);
 }
 document.querySelector("#chatHubBtn").title=t("chats");
 renderAdminAlertBadge();
}
async function markThreadRead(threadId){
 try{
  const data=await exchangeFetch("/api/exchange/threads/read",{
   method:"POST",body:JSON.stringify({thread_id:threadId})
  });
  replaceThread(data.thread);
  renderChatBadge();
  if(!document.querySelector("#messenger").classList.contains("hidden"))renderMessenger();
 }catch(error){console.warn("exchange mark thread read",error)}
}
function openAdminRequests(){return chatThreads.filter(thread=>thread.adminRequest?.status==="open")}
function renderAdminAlertBadge(){
 const pendingReserve=reserveWithdrawalRequests.filter(request=>request.status==="pending").length;
 const openCalls=isAdmin()?adminOpenRequestCount:openAdminRequests().length;
 const count=openCalls+pendingReserve,badge=document.querySelector("#adminAlertBadge"),tabBadge=document.querySelector("#adminCallsTabBadge"),reserveBadge=document.querySelector("#adminReserveTabBadge");
 if(badge){badge.textContent=count;badge.classList.toggle("hidden",count===0)}
 if(tabBadge)tabBadge.textContent=openCalls;
 if(reserveBadge)reserveBadge.textContent=pendingReserve;
}
function closeAdminHelpDialog(){
 if(adminHelpSubmitting)return;
 pendingAdminHelpThreadId=null;
 document.querySelector("#adminHelpDialog")?.classList.add("hidden");
}
function openAdminHelpDialog(threadId){
 const thread=chatThreads.find(candidate=>candidate.id===threadId);
 if(!thread||thread.adminRequest?.status==="open")return;
 pendingAdminHelpThreadId=String(threadId);
 const dialog=document.querySelector("#adminHelpDialog"),reason=document.querySelector("#adminHelpReason"),details=document.querySelector("#adminHelpDetails"),error=document.querySelector("#adminHelpError"),counter=document.querySelector("#adminHelpCounter");
 if(reason)reason.value="";
 if(details)details.value="";
 if(error)error.textContent="";
 if(counter)counter.textContent="0";
 dialog?.classList.remove("hidden");
 setTimeout(()=>reason?.focus(),0);
}
async function requestAdminHelp(threadId,reason){
 const thread=chatThreads.find(candidate=>candidate.id===String(threadId));
 if(!thread||thread.adminRequest?.status==="open"||adminHelpSubmitting)return;
 adminHelpSubmitting=true;
 const submit=document.querySelector("#adminHelpSubmit"),errorBox=document.querySelector("#adminHelpError");
 if(submit)submit.disabled=true;
 if(errorBox)errorBox.textContent="";
 try{
  const data=await exchangeFetch("/api/exchange/threads/admin-request",{
   method:"POST",body:JSON.stringify({thread_id:threadId,reason})
  });
  replaceThread(data.thread);
  if(isAdmin())adminOpenRequestCount+=1;
  pendingAdminHelpThreadId=null;
  document.querySelector("#adminHelpDialog")?.classList.add("hidden");
  renderMessenger();
  renderAdminAlertBadge();
 }catch(error){
  if(error.code==="admin_request_open"){
   pendingAdminHelpThreadId=null;
   document.querySelector("#adminHelpDialog")?.classList.add("hidden");
   await loadExchangeState({quiet:true});
   alert(dealErrorText(error));
  }else if(errorBox)errorBox.textContent=dealErrorText(error);
 }finally{
  adminHelpSubmitting=false;
  if(submit)submit.disabled=false;
 }
}
async function setChatUserBlocked(thread,blocked){
 const targetId=threadPartnerId(thread);
 if(!targetId)return;
 const question=blocked
  ?`Заблокировать ${threadPartner(thread)}? Его объявления исчезнут, а новые сообщения между вами будут запрещены.`
  :`Разблокировать ${threadPartner(thread)}?`;
 if(!confirm(question))return;
 try{
  await exchangeFetch("/api/exchange/users/block",{
   method:"POST",body:JSON.stringify({target_tg_id:targetId,blocked})
  });
  await loadExchangeState({quiet:true});
  activeThreadId=String(thread.id);
  renderMessenger();
 }catch(error){alert(`Не удалось изменить блокировку: ${error.message}`)}
}
async function resolveAdminHelp(threadId){
 if(!isAdmin())return;
 const thread=chatThreads.find(candidate=>candidate.id===threadId);
 if(!thread||thread.adminRequest?.status!=="open")return;
 try{
  await exchangeFetch("/api/exchange/admin/action",{
   method:"POST",body:JSON.stringify({action:"resolve_request",thread_id:threadId})
  });
  thread.adminRequest={...(thread.adminRequest||{}),status:"resolved"};
  adminOpenRequestCount=Math.max(0,adminOpenRequestCount-1);
  if(adminTab==="calls"){
   adminThreadResultIds=adminThreadResultIds.filter(id=>id!==String(threadId));
   adminThreadPage={...adminThreadPage,total:Math.max(0,Number(adminThreadPage.total||0)-1)};
  }
  await loadExchangeState({quiet:true});
 }catch(error){alert(`Не удалось закрыть вызов: ${error.message}`)}
}
function openMessenger(threadId=null,showList=false){
 const available=visibleThreads();
 if(showList){activeThreadId=null;conversationPanel=null;conversationPanelThreadId=null}
 else{
  if(threadId&&threadId!==activeThreadId){conversationPanel=null;conversationPanelThreadId=null}
  activeThreadId=threadId||activeThreadId;
  if(!available.some(thread=>thread.id===activeThreadId))activeThreadId=available[0]?.id||null;
 }
 document.querySelector("#messenger").classList.remove("hidden");
 document.body.classList.add("messenger-open");
 syncExchangeViewport();
 renderMessenger();
 const active=chatThreads.find(thread=>thread.id===activeThreadId);
 if(active?.compact){
  void loadExchangeThreadDetail(active.id).then(()=>{
   if(activeThreadId===active.id&&!document.querySelector("#messenger").classList.contains("hidden"))renderMessenger();
  }).catch(error=>console.error("exchange thread detail",error));
 }
}
function closeMessenger(){
 document.querySelector("#messenger").classList.add("hidden");
 document.body.classList.remove("messenger-open");
 conversationPanel=null;
 conversationPanelThreadId=null;
}
function toggleConversationPanel(threadId,panel){
 const sameThread=conversationPanelThreadId===threadId;
 conversationPanel=sameThread&&conversationPanel===panel?null:panel;
 conversationPanelThreadId=conversationPanel?threadId:null;
 renderMessenger();
}
function conversationDealSummary(thread){
 if(thread.deal)return dealStateLabel(thread.deal);
 if(thread.mode==="trade")return "Переписка";
 return "Не начата";
}
function availableThreadMethods(item){
 return [
  item.cash!=null?{mode:"cash",...methodDetails("cash",item)}:null,
  item.brains!=null?{mode:"brains",...methodDetails("brains",item)}:null,
  item.stars!=null?{mode:"stars",...methodDetails("stars",item)}:null,
  item.trade?{mode:"trade",...methodDetails("trade",item)}:null
 ].filter(Boolean);
}
function dealStateLabel(deal){
 const labels={
  awaiting_seller:"Ждём продавца",
  awaiting_confirmation:"Ждём подтверждение продавца",
  awaiting_guarantor_fee:"Ждём оплату комиссии",
  item_transfer:"Продавец передаёт предмет",
  item_sent:"Ждём подтверждение покупателя",
  seeking_guarantor:"Ищем гаранта",
  awaiting_collateral:"Ожидается залог",
  awaiting_cash:"Ждём оплату",
  buyer_paid:"Проверяется оплата",
  cash_secured:"Оплата подтверждена",
  awaiting_payout:"Ждём выплату продавцу",
  disputed:"Открыт спор",
  completed:"Сделка завершена",
  cancelled:"Сделка отменена",
  refunded:"Мозги возвращены",
  compensated:"Выплачена компенсация"
 };
 return labels[deal?.status]||deal?.status||"Нет сделки";
}
function dealStatusClass(status){
 if(["completed","compensated"].includes(status))return "done";
 if(["cancelled","refunded","disputed"].includes(status))return "danger";
 return "";
}
function dealProgressIndex(deal){
 if(!deal)return 0;
 if(deal.method==="brains"){
  return {awaiting_seller:1,item_transfer:2,item_sent:3,completed:4,refunded:4,cancelled:4,disputed:2}[deal.status]||1;
 }
 return {awaiting_confirmation:1,awaiting_guarantor_fee:1,seeking_guarantor:1,awaiting_collateral:1,awaiting_cash:2,buyer_paid:2,cash_secured:3,item_transfer:2,item_sent:3,awaiting_payout:4,completed:4,compensated:4,cancelled:4,disputed:2}[deal.status]||1;
}
function dealButton(action,label,kind="",dealId="",disabled=false){
 return `<button type="button" class="${kind}" data-deal-action="${action}"${dealId!==""?` data-deal-id="${dealId}"`:""}${disabled?" disabled aria-disabled=\"true\"":""}>${label}</button>`;
}
function adminBrainDecisionButtons(deal,dealId=""){
 if(!deal||deal.method!=="brains"||deal.escrowStatus!=="held"||terminalDealStatuses.has(deal.status))return "";
 return `${dealButton("admin_refund","Вернуть покупателю","danger",dealId)}${dealButton("admin_release","Передать продавцу","primary",dealId)}`;
}
function adminBrainConsoleButtons(deal){
 if(!deal||deal.method!=="brains"||deal.escrowStatus!=="held"||terminalDealStatuses.has(deal.status))return "";
 return `<button class="danger" data-admin-deal-action="${deal.id}" data-action="admin_refund">Вернуть покупателю</button><button class="success" data-admin-deal-action="${deal.id}" data-action="admin_release">Передать продавцу</button>`;
}
function confirmAdministrativeDealAction(deal,action){
 const amount=formatNumber(deal?.amount||0);
 if(action==="admin_refund")return confirm(`Вернуть ${amount} 🧠 покупателю? Сделка будет закрыта, повторить решение нельзя.`);
 if(action==="admin_release")return confirm(`Передать ${amount} 🧠 продавцу? Сделка будет завершена, повторить решение нельзя.`);
 if(["admin_cancel","admin_complete_cash","admin_return_collateral","admin_compensate"].includes(action))return confirm("Подтвердить административное решение? Оно изменит состояние сделки и может изменить баланс участника.");
 return true;
}
function formatNumber(value){
 return Number(value||0).toLocaleString(language==="ru"?"ru-RU":"en-US");
}
function dealErrorText(error){
 const labels={
  wager_required:`Сначала заверши отыгрыш: осталось ${formatNumber(error?.payload?.wager_remaining||0)} 🧠 из ${formatNumber(error?.payload?.wager_required||0)} 🧠.`,
  insufficient_collateral_balance:`Для залога нужно ${formatNumber(error?.payload?.required||0)} 🧠. Свободного баланса не хватает.`,
  insufficient_balance:"На балансе недостаточно мозгов.",
  insufficient_public_reserve:`В свободном резерве только ${formatNumber(error?.payload?.available||0)} 🧠.`,
  reserve_withdrawal_already_pending:`Заявка #${error?.payload?.requestId||""} уже рассматривается. Дождись решения администратора.`,
  request_already_reviewed:"Эта заявка уже обработана другим администратором.",
  invalid_reserve_request:"Введи целое положительное количество мозгов.",
  action_not_allowed:"Этот этап сделки уже изменился. Состояние обновлено.",
  deal_finished:"Сделка уже завершена.",
  deal_already_active:"В этом чате уже идёт активная сделка.",
  listing_inactive:"Объявление уже скрыто, продано или участвует в другой сделке.",
  collateral_not_held:"Залог уже возвращён или выплачен, повторное действие запрещено.",
  escrow_resolution_failed:"Замороженные мозги уже были возвращены или переданы. Обнови сделку.",
  buyer_required:"Запустить сделку может только покупатель."
  ,currency_rates_unavailable:"Не удалось получить актуальный курс этой валюты. Попробуй ещё раз чуть позже."
  ,guarantor_limit_exceeded:"Сумма сделки выше персонального лимита этого гаранта. Сделку может взять другой гарант."
  ,guarantor_fee_below_minimum:`Гаранта можно вызвать только когда его комиссия составляет минимум ${formatNumber(error?.payload?.minimum||3)} 🧠.`
  ,no_eligible_guarantor:"Сейчас нет свободного гаранта, чей лимит подходит для этой суммы."
  ,guarantor_inactive:"Этот гарант уже отключён администратором."
  ,insufficient_guarantor_fee_balance:`Для комиссии гаранта нужно ${formatNumber(error?.payload?.required||0)} 🧠 в балансе или гарантийном резерве.`
  ,guarantor_fee_not_paid:"Комиссия ещё не оплачена покупателем или продавцом."
  ,reserve_changed:"Размер резерва изменился. Данные обновлены, попробуй ещё раз."
  ,admin_reason_required:"Укажи причину вызова администратора."
  ,admin_request_open:"Администратор уже вызван в этот чат. Новый вызов станет доступен после закрытия текущего."
  ,admin_request_closed:"Этот вызов уже закрыт другим администратором."
 };
 return labels[error?.code]||error?.message||"Неизвестная ошибка";
}
function renderDealWorkflow(thread,item){
 const deal=thread?.deal;
 if(!deal){
  if(!["brains","cash","stars"].includes(thread.mode))return "";
  const buyer=Number(currentAccount.tg_id)===Number(thread.buyer_tg_id);
  const amount=thread.mode==="brains"?item?.brains:thread.mode==="stars"?item?.stars:item?.cash;
  const rubEquivalent=thread.mode==="cash"?cashValueInRub(item):null;
  const collateralAmount=rubEquivalent==null?null:Math.ceil(Number(rubEquivalent)/1.1);
  const dealRub=thread.mode==="stars"?Number(item?.stars||0)*1.5:rubEquivalent;
  const guardOptions=exchangeGuarantors.filter(guard=>{
   if(!guard.active)return false;
   if(Number(guard.maxDealRub||0)>0&&Number(dealRub||0)>Number(guard.maxDealRub))return false;
   const baseBrains=thread.mode==="stars"?Number(item?.stars||0)/1.5:Number(dealRub||0)/1.1;
   return Math.floor(baseBrains*(Number(guard.feePercent)||0)/100)>=3;
  }).map(guard=>{
   const baseBrains=thread.mode==="stars"?Number(item?.stars||0)/1.5:Number(dealRub||0)/1.1;
   return {...guard,feeBrains:Math.floor(baseBrains*(Number(guard.feePercent)||0)/100)};
  });
  const minimumGuardFee=guardOptions.length?Math.min(...guardOptions.map(guard=>guard.feeBrains)):0;
  const guarantorLabel=guardOptions.length
   ?`С гарантом · комиссия от ${formatNumber(minimumGuardFee)} 🧠`
   :"С гарантом · недоступно для этой суммы";
  const launchActions=thread.mode==="brains"
   ?dealButton("start",`Заморозить ${formatNumber(amount)} 🧠`,"primary")
   :`${dealButton("start_guarantor",guarantorLabel,"primary","",!guardOptions.length)}
     ${dealButton("start_collateral",thread.mode==="stars"||collateralAmount==null?"Под залог · расчёт при запуске":`Под залог ${formatNumber(collateralAmount)} 🧠`,"trust")}
     ${dealButton("start_trust","Доверие · без защиты","plain-trust")}`;
  return `<section class="deal-workflow deal-workflow-empty">
   <div class="deal-workflow-head"><div><small>${thread.mode==="brains"?"BRAINBET ESCROW":"SAFE DEAL"}</small><b>${thread.mode==="brains"?"Оплата мозгами":"Выбери защиту сделки"}</b></div><span class="deal-state">Не начата</span></div>
   <p class="deal-workflow-note">${thread.mode==="brains"?"После запуска сумма будет заморожена на сервере. Продавец получит её только после подтверждения получения предмета.":"Выбери защиту до запуска. Карточка закрепится только после подтверждения продавца, внесения залога или принятия гарантом."}</p>
   ${thread.mode!=="brains"?`<div class="deal-flow-compare"><span><b>Гарант</b><small>Контролирует оплату и выдачу · комиссия</small></span><span><b>Залог</b><small>Мозги отвечают за одну сторону</small></span><span><b>Доверие</b><small>Без комиссии и без защиты</small></span></div>`:""}
   ${buyer?`<div class="deal-action-row deal-launch-actions">${launchActions}</div>`:`<small class="deal-workflow-note">Покупатель ещё не запустил сделку.</small>`}
  </section>`;
 }
 const progress=dealProgressIndex(deal);
 const steps=[1,2,3,4].map(step=>`<span class="${step<=progress?"done":""}"></span>`).join("");
 const buyer=Number(currentAccount.tg_id)===Number(deal.buyerTgId);
 const seller=Number(currentAccount.tg_id)===Number(deal.sellerTgId);
 const guard=Number(currentAccount.tg_id)===Number(deal.guarantorTgId);
 const admin=Boolean(currentAccount.isAdmin);
 const directAdmin=deal.escrowStatus==="direct_admin";
 const collateralFlow=deal.cashFlow==="collateral"||String(deal.escrowStatus||"").startsWith("trust_");
 const directTrust=deal.cashFlow==="trust"||String(deal.escrowStatus||"").startsWith("direct_trust");
 const collateral=deal.collateral;
 const collateralHeld=collateral?.status==="held";
 const collateralOwnerBuyer=Number(collateral?.ownerTgId)===Number(deal.buyerTgId);
 const collateralOwnerSeller=Number(collateral?.ownerTgId)===Number(deal.sellerTgId);
 const reserveOwner=collateralOwnerBuyer?deal.buyer:collateralOwnerSeller?deal.seller:"";
 const canTrustCancel=collateralFlow&&(deal.status==="awaiting_collateral"
  ||collateralOwnerSeller&&deal.status==="awaiting_cash"
  ||collateralOwnerBuyer&&deal.status==="item_transfer");
 const actions=[];
 if(deal.method==="brains"){
  if(deal.status==="awaiting_seller"&&seller){actions.push(dealButton("seller_accept","Принять сделку","primary"),dealButton("seller_reject","Отклонить","danger"))}
  if(deal.status==="item_transfer"&&seller)actions.push(dealButton("item_sent","Предмет передан","primary"));
  if(deal.status==="item_sent"&&buyer)actions.push(dealButton("buyer_received","Я получил предмет","primary"));
 }else{
  if(deal.status==="awaiting_confirmation"&&seller)actions.push(
   dealButton("seller_accept_cash","Подтвердить запрос","primary"),
   dealButton("seller_reject_cash","Отклонить","danger")
  );
  if(deal.status==="awaiting_guarantor_fee"&&(buyer||seller))actions.push(
   dealButton("pay_guarantor_fee",`Оплатить комиссию ${formatNumber(deal.guarantorFeeBrains)} 🧠`,"primary"),
   dealButton("cancel_guarantor_fee","Отменить сделку","danger")
  );
  if(deal.status==="awaiting_collateral"&&(buyer||seller))actions.push(dealButton("reserve_collateral",`Зарезервировать ${formatNumber(deal.requiredCollateralBrains)} 🧠`,"trust"));
  if(deal.status==="seeking_guarantor"&&(currentAccount.isGuarantor||admin)&&!buyer&&!seller)actions.push(dealButton("guarantor_accept","Взять сделку","primary"));
  if(deal.status==="awaiting_cash"&&buyer)actions.push(dealButton("buyer_paid","Я передал оплату","primary"));
  if(deal.status==="buyer_paid"&&(guard||(collateralFlow||directTrust)&&seller))actions.push(dealButton("cash_secured",(collateralFlow||directTrust)?"Деньги получены":"Оплата у меня","primary"));
  if(deal.status==="cash_secured"&&seller)actions.push(dealButton("item_sent","Предмет передан","primary"));
  if(deal.status==="item_transfer"&&collateralFlow&&collateralOwnerBuyer&&seller)actions.push(dealButton("item_sent","Я передал предмет","primary"));
  if(deal.status==="item_sent"&&buyer)actions.push(dealButton("buyer_received","Я получил предмет","primary"));
  if(deal.status==="awaiting_payout"&&guard)actions.push(dealButton("guarantor_payout","Выплатить продавцу","primary"));
  if(["awaiting_cash","buyer_paid"].includes(deal.status)&&guard)actions.push(dealButton("guarantor_cancel","Отменить сделку","danger"));
  if(canTrustCancel&&(buyer||seller))actions.push(dealButton(
   "trust_cancel",
   collateralHeld?"Отменить и вернуть залог":"Отменить сделку",
   "danger"
  ));
 }
 if(buyer&&!collateralFlow&&["awaiting_seller","awaiting_confirmation","seeking_guarantor","awaiting_cash"].includes(deal.status))actions.push(dealButton("buyer_cancel","Отменить","danger"));
 if(admin&&!terminalDealStatuses.has(deal.status)){
  if(collateralFlow&&collateralHeld)actions.push(
   dealButton("admin_compensate","Компенсировать второй стороне","danger"),
   dealButton("admin_return_collateral","Вернуть залог владельцу","")
  );
  else if(deal.method==="brains"&&deal.escrowStatus==="held")actions.push(adminBrainDecisionButtons(deal));
  else actions.push(dealButton("admin_cancel","Отменить сделку","danger"));
 }
 const history=(deal.events||[]).slice(-6).map(event=>`<div>${escapeHtml(event.actor)} · ${escapeHtml(event.details||event.event)}</div>`).join("");
 const confirmationPanel=deal.status==="awaiting_confirmation"
  ?`<div class="deal-confirmation-pending"><b>ОБЪЯВЛЕНИЕ ЕЩЁ СВОБОДНО</b><small>Запрос не блокирует карточку. Она закрепится за этой сделкой только после подтверждения продавца.</small></div>`
  :"";
 const guarantorFeePanel=deal.status==="awaiting_guarantor_fee"
  ?`<div class="deal-confirmation-pending"><b>НУЖНО ОПЛАТИТЬ КОМИССИЮ</b><small>Покупатель и продавец уже согласились на гаранта. Комиссию ${formatNumber(deal.guarantorFeeBrains)} 🧠 может оплатить любая сторона. Кто оплатит первым, тот станет плательщиком; после этого заявку увидят гаранты.</small></div>`
  :"";
 const collateralPanel=collateralFlow?`<div class="deal-collateral ${collateralHeld?"held":collateral?.status||"pending"}">
   <div class="deal-collateral-title"><span>◆</span><div><small>ГАРАНТИЙНЫЙ ЗАЛОГ</small><b>${formatNumber(deal.requiredCollateralBrains)} 🧠</b></div><em>1 🧠 = 1,1 ₽</em></div>
   ${collateral
    ?`<div class="deal-collateral-owner"><span>Зарезервировал</span><strong>${escapeHtml(reserveOwner)}</strong><i>${collateral.status==="held"?"УДЕРЖИВАЕТСЯ":collateral.status==="returned"?"ВОЗВРАЩЁН":"КОМПЕНСАЦИЯ"}</i></div>
      <p>${collateralOwnerBuyer?"Покупатель отвечает залогом, поэтому продавец передаёт предмет первым.":"Продавец отвечает залогом, поэтому покупатель переводит деньги первым."}</p>`
    :`<p>Залог может внести любая сторона. После первого резерва порядок сделки фиксируется и изменить владельца залога нельзя.</p>`}
  </div>`:"";
 return `<section class="deal-workflow">
  <div class="deal-workflow-head"><div><small>${deal.method==="brains"?"BRAINBET ESCROW":collateralFlow?"SAFE DEAL / ЗАЛОГ":directTrust?"DIRECT / ДОВЕРИЕ":"SAFE DEAL / ГАРАНТ"}</small><b>${deal.method==="brains"?`${formatNumber(deal.amount)} 🧠`:deal.method==="stars"?`${formatNumber(deal.amount)} ★`:formatCashPrice(deal.amount,deal.currency||"RUB")} · ${escapeHtml(dealStateLabel(deal))}</b></div><span class="deal-state ${dealStatusClass(deal.status)}">${escapeHtml(dealStateLabel(deal))}</span></div>
  <div class="deal-progress">${steps}</div>
 ${confirmationPanel}
  ${guarantorFeePanel}
  ${deal.method==="cash"&&deal.currency!=="RUB"&&Number(deal.amountRub)>0?`<div class="deal-rate-snapshot"><span>КУРС ЗАФИКСИРОВАН</span><b>≈ ${formatCashPrice(deal.amountRub,"RUB")}</b></div>`:""}
  ${directAdmin?`<div class="deal-direct-admin"><b>ПРЯМАЯ СДЕЛКА С АДМИНИСТРАТОРОМ</b><small>Отдельный гарант не нужен. Продавец подтверждает оплату, затем передаёт предмет.</small></div>`:""}
  ${directTrust?`<div class="deal-direct-trust"><b>СДЕЛКА НА ДОВЕРИИ</b><small>BrainBet не удерживает оплату и залог. Обе стороны проводят передачу напрямую и принимают риск.</small></div>`:""}
  ${collateralPanel}
  <div class="deal-escrow"><span>${deal.method==="brains"?"Статус мозгов":collateralFlow?"Статус залога":"Статус оплаты"}</span><strong>${deal.escrowStatus==="held"?"ЗАМОРОЖЕНО":deal.escrowStatus==="released"?"ПЕРЕДАНО":deal.escrowStatus==="refunded"?"ВОЗВРАЩЕНО":deal.escrowStatus==="direct_admin"?"ПРЯМАЯ СДЕЛКА":directTrust?"БЕЗ ЗАЩИТЫ":collateralFlow&&collateral?.status==="held"?"ЗАМОРОЖЕН":collateralFlow&&collateral?.status==="returned"?"ВОЗВРАЩЁН":collateralFlow&&collateral?.status==="compensated"?"ВЫПЛАЧЕН":collateralFlow?"ОЖИДАЕТ РЕЗЕРВА":deal.status==="completed"?"ЗАВЕРШЕНО":"ВНЕ ПРИЛОЖЕНИЯ"}</strong></div>
  ${deal.guarantor?`<div class="deal-guard">Гарант: <b>${escapeHtml(deal.guarantor)}</b></div>`:""}
  ${Number(deal.guarantorFeeBrains||0)>0?`<div class="deal-guard-fee ${escapeHtml(deal.guarantorFeeStatus||"none")}"><span>КОМИССИЯ ГАРАНТА</span><b>${formatNumber(deal.guarantorFeeBrains)} 🧠</b><small>${deal.guarantorFeeStatus==="held"?`заморожена · платит ${Number(deal.guarantorFeePayerTgId)===Number(deal.buyerTgId)?"покупатель":"продавец"}`:deal.guarantorFeeStatus==="paid"?"выплачена гаранту":deal.guarantorFeeStatus==="refunded"?"возвращена плательщику":"ожидает оплаты одной из сторон"}</small></div>`:""}
  ${actions.length?`<div class="deal-action-row">${actions.join("")}</div>`:""}
  ${history?`<details class="deal-history"><summary>История сделки</summary>${history}</details>`:""}
 </section>`;
}
async function startEscrowDeal(thread,cashFlow="guarantor"){
 const item=threadItem(thread);
 if(!item)return;
 try{
  const data=await exchangeFetch("/api/exchange/deals/start",{method:"POST",body:JSON.stringify({thread_id:thread.id,cash_flow:cashFlow})});
  replaceThread(data.thread);
  if(data.balance!=null){currentAccount.balance=data.balance;renderAccounts()}
  await loadExchangeState({quiet:true});
  activeThreadId=String(data.thread.id);
  renderMessenger();renderGuarantorBadge();renderGuaranteeConsole();
 }catch(error){alert(`Не удалось запустить сделку: ${dealErrorText(error)}`)}
}
async function performDealAction(thread,action){
 const deal=thread?.deal;
 if(!deal)return;
 if(action.startsWith("admin_")&&!confirmAdministrativeDealAction(deal,action))return;
 try{
  const data=await exchangeFetch("/api/exchange/deals/action",{method:"POST",body:JSON.stringify({deal_id:deal.id,action})});
  replaceThread(data.thread);
  if(data.balance!=null){currentAccount.balance=data.balance;renderAccounts()}
  await loadExchangeState({quiet:true});
  activeThreadId=String(data.thread.id);
  renderMessenger();renderGuarantorBadge();renderGuaranteeConsole();
 }catch(error){
  alert(`Действие сделки не выполнено: ${dealErrorText(error)}`);
  await loadExchangeState({quiet:true});
 }
}
function renderMessenger(){
 const previousComposer=document.querySelector("#messengerInput");
 const restoreComposerFocus=Boolean(previousComposer&&document.activeElement===previousComposer);
 const restoreComposerSelection=restoreComposerFocus
  ?[previousComposer.selectionStart,previousComposer.selectionEnd]
  :null;
 if(previousComposer&&activeThreadId)chatDrafts.set(activeThreadId,previousComposer.value);
 const allThreads=visibleThreads();
 const query=chatQuery.trim().toLowerCase();
 const available=allThreads.filter(thread=>{
  const item=threadItem(thread);
  return !query||`${threadPartner(thread)} ${item?.name||""}`.toLowerCase().includes(query);
 });
 const active=allThreads.find(thread=>thread.id===activeThreadId)||null;
 const shell=document.querySelector("#messengerShell");
 shell.classList.toggle("has-active",Boolean(active));
 document.querySelector("#threadList").innerHTML=available.length?available.map(thread=>{
  const item=threadItem(thread),partner=threadPartner(thread),last=thread.messages.at(-1),availability=listingAvailability(item);
  const unread=Boolean(thread.unread||thread.unreadFor.includes(currentAccount.username));
  const unreadCount=Number(thread.unreadCount)||0;
  return `<button class="thread-row ${thread.id===activeThreadId?"active":""} ${unread?"unread":""}" data-thread-id="${thread.id}">
   <span class="chat-avatar">${escapeHtml(partner.replace("@","")[0]?.toUpperCase()||"?")}</span>
   <span class="thread-copy"><b>${escapeHtml(partner)}</b><small class="${availability.valid?"":"invalid"}">${escapeHtml(item?.name||"Удалённое объявление")}${availability.valid?"":` · НЕДЕЙСТВИТЕЛЬНО`}</small><em>${escapeHtml(last?.text||"")}</em></span>
   <span class="thread-meta"><small>${last?.time||""}</small>${unread?`<i>${unreadCount>99?"99+":unreadCount||"1"}</i>`:""}</span>
  </button>`;
 }).join(""):`<div class="no-threads"><b>${t("no_chats")}</b><small>${t("no_chats_hint")}</small></div>`;
 const pane=document.querySelector("#conversationPane");
 if(!active){
  pane.innerHTML=`<div class="empty-conversation"><span>✉</span><b>${t("choose_chat")}</b><small>${t("choose_chat_hint")}</small></div>`;
 }else{
  if(!adminAllChatsMode){
   const shouldMarkRead=Boolean(active.unread||active.unreadFor.includes(currentAccount.username));
   active.unread=false;
   active.unreadCount=0;
   active.unreadFor=active.unreadFor.filter(username=>username!==currentAccount.username);
   if(shouldMarkRead)void markThreadRead(active.id);
  }
  const storedItem=threadItem(active);
  const item=storedItem||{name:active.deal?.listingName||"Удалённое объявление",img:"",brainrots:[]};
  const partner=threadPartner(active),method=methodDetails(active.mode,item),availability=listingAvailability(storedItem);
  const viewerRole=threadViewerRole(active);
  const partnerId=threadPartnerId(active),partnerBlocked=partnerId>0&&blockedUserIds.has(partnerId);
  const buyerReserve=Number(active.buyerReservedBrains||0);
  const sellerReserve=Number(active.sellerReservedBrains||0);
  const totalReserve=buyerReserve+sellerReserve;
  const activePanel=conversationPanelThreadId===active.id?conversationPanel:null;
  const partnerRoleLabel=viewerRole==="guarantor"
   ?"ПОКУПАТЕЛЬ ↔ ПРОДАВЕЦ"
   :viewerRole==="buyer"?"ПРОДАВЕЦ":"ПОКУПАТЕЛЬ";
  const presence=threadPresence(active);
  const canChangeMethod=!adminAllChatsMode&&viewerRole==="buyer"&&availability.valid&&!(active.deal&&!terminalDealStatuses.has(active.deal.status));
  const invalidPanel=availability.valid?"":`<div class="listing-invalid-banner"><span>!</span><div><b>${availability.label}</b><small>${availability.detail}. Новую сделку по этой карточке начинать нельзя.</small></div></div>`;
  const methodChangePanel=canChangeMethod&&methodPickerThreadId===active.id?`<div class="method-change-panel">
    <div class="section-caption">${t("change_method_title")}</div>
    <div class="method-change-options">${availableThreadMethods(item).map(option=>`<button class="method-change-option ${option.mode===active.mode?"current":""}" type="button" data-new-method="${option.mode}" ${option.mode===active.mode?"disabled":""}><span>${option.icon}</span><b>${option.title}</b><small>${option.value}</small></button>`).join("")}</div>
    <button class="method-change-cancel" id="cancelMethodChange" type="button">${t("cancel")}</button>
   </div>`:"";
  const listingPanel=`<div class="conversation-listing ${availability.valid?"":"invalid"}">
    <div class="conversation-listing-visual">${item.screenshots?.length?`<button class="conversation-seller-photo" id="conversationSellerPhoto" type="button"><img src="${item.screenshots[0].url}" alt="Фото продавца"><span>ОТКРЫТЬ ФОТО</span></button>`:listingMedia(item,"chat")}</div>
    <span class="conversation-listing-copy"><small>${language==="ru"?"ПРЕДМЕТ":"ITEM"}</small><b>${escapeHtml(item.name)}</b><em>${active.mode==="cash"?"ПОКУПКА ЗА ДЕНЬГИ":active.mode==="brains"?"ПОКУПКА ЗА МОЗГИ":active.mode==="stars"?"ОПЛАТА TELEGRAM STARS":"ОБМЕН ПРЕДМЕТАМИ"}</em></span>
    <div class="conversation-method"><strong>${active.mode==="cash"?method.value:`${method.icon} ${method.value}`}</strong>${canChangeMethod?`<button id="changeThreadMethod" type="button">${t("change_method")}</button>`:""}</div>
   </div>${invalidPanel}${methodChangePanel}`;
  const reservePanel=`<div class="conversation-reserve-board">
    <div><small>ПОКУПАТЕЛЬ · ${escapeHtml(active.buyer)}</small><strong>◆ ${formatNumber(buyerReserve)} 🧠</strong><span>активный резерв</span></div>
    <i>ГАРАНТИЯ СТОРОН</i>
    <div><small>ПРОДАВЕЦ · ${escapeHtml(active.seller)}</small><strong>◆ ${formatNumber(sellerReserve)} 🧠</strong><span>активный резерв</span></div>
   </div><div class="conversation-panel-note">Резерв принадлежит пользователю и не списывается без подтверждённого этапа сделки.</div>`;
  const workflowPanel=renderDealWorkflow(active,item)||`<div class="conversation-panel-empty"><b>Сделка через приложение не запущена</b><small>Для обмена предметами договоритесь в сообщениях. При необходимости вызовите администратора.</small></div>`;
  const drawerTitle=activePanel==="listing"?"Карточка товара":activePanel==="reserve"?"Резерв сторон":"Ход сделки";
  const drawerBody=activePanel==="listing"?listingPanel:activePanel==="reserve"?reservePanel:`${invalidPanel}${workflowPanel}`;
  pane.innerHTML=`<header class="conversation-head">
    <button class="messenger-back" id="messengerBack" type="button" aria-label="Back">‹</button>
    <button class="chat-avatar public-profile-link" type="button" data-chat-profile="${partnerId}" aria-label="Открыть профиль">${escapeHtml(partner.replace("@","")[0]?.toUpperCase()||"?")}</button>
    <span class="chat-person"><small>${partnerRoleLabel}</small><b>${escapeHtml(partner)}</b><i class="${presence.online?"online":"offline"}"><em></em>${escapeHtml(presence.label)}</i></span>
    <span class="conversation-actions">
     ${adminAllChatsMode||!partnerId?"":`<button class="conversation-block ${partnerBlocked?"active":""}" id="blockChatUser" type="button" title="${partnerBlocked?"Разблокировать пользователя":"Заблокировать пользователя"}" aria-label="${partnerBlocked?"Разблокировать пользователя":"Заблокировать пользователя"}">⊘</button>`}
     <button class="conversation-close" id="closeMessengerConversation" type="button" aria-label="Close">×</button>
    </span>
   </header>
   <nav class="conversation-summary-bar" aria-label="Информация о диалоге">
    <button class="conversation-summary-tile listing ${activePanel==="listing"?"active":""} ${availability.valid?"":"warning"}" type="button" data-conversation-panel="listing" aria-expanded="${activePanel==="listing"}">
     <small>ОБЪЯВЛЕНИЕ</small><b>${availability.valid?"ТОВАР":"НЕДОСТУПНО"}</b><em>${activePanel==="listing"?"Скрыть":"Открыть"}</em>
    </button>
    <button class="conversation-summary-tile ${activePanel==="reserve"?"active":""}" type="button" data-conversation-panel="reserve" aria-expanded="${activePanel==="reserve"}"><small>РЕЗЕРВ</small><b>${formatNumber(totalReserve)} 🧠</b><em>${activePanel==="reserve"?"Скрыть":"Подробнее"}</em></button>
    <button class="conversation-summary-tile deal ${activePanel==="deal"?"active":""} ${dealStatusClass(active.deal?.status)}" type="button" data-conversation-panel="deal" aria-expanded="${activePanel==="deal"}"><small>СДЕЛКА</small><b>${escapeHtml(conversationDealSummary(active))}</b><em>${active.deal?"Этапы и действия":"Открыть"}</em></button>
   </nav>
   ${activePanel?`<section class="conversation-drawer"><header><b>${drawerTitle}</b><button id="closeConversationPanel" type="button" aria-label="Закрыть панель">×</button></header><div class="conversation-drawer-body">${drawerBody}</div></section>`:""}
   <div class="messenger-messages" id="messengerMessages">${active.messages.map(message=>renderThreadMessage(active,message)).join("")}</div>
   ${adminAllChatsMode?`<div class="admin-readonly-note admin-chat-access">◆ АДМИНИСТРАТОР ПОДКЛЮЧЁН К ЧАТУ · ${escapeHtml(active.buyer)} ↔ ${escapeHtml(active.seller)}${active.adminRequest?.status==="open"?` · ПРИЧИНА: ${escapeHtml(active.adminRequest.reason||"не указана")}<button id="resolveAdminCall" type="button">ЗАКРЫТЬ ВЫЗОВ</button>`:""}</div>`:viewerRole==="guarantor"?`<div class="admin-readonly-note">◆ ВЫ НАЗНАЧЕННЫЙ ГАРАНТ · сообщения видят обе стороны сделки</div>`:`<div class="call-admin-bar"><button id="callAdminButton" type="button" ${active.adminRequest?.status==="open"?"disabled":""}>${active.adminRequest?.status==="open"?"◆ АДМИНИСТРАТОР ВЫЗВАН":"◆ ВЫЗВАТЬ АДМИНИСТРАТОРА"}</button><small>${active.adminRequest?.status==="open"?`Причина: ${escapeHtml(active.adminRequest.reason||"не указана")}`:"Проблема со сделкой?"}</small></div>`}
   ${!adminAllChatsMode&&partnerBlocked
    ?`<div class="blocked-chat-note"><b>ПОЛЬЗОВАТЕЛЬ ЗАБЛОКИРОВАН</b><small>Сообщения отключены. Старую переписку можно просматривать.</small><button id="unblockChatUser" type="button">РАЗБЛОКИРОВАТЬ</button></div>`
    :`<div class="messenger-compose"><textarea id="messengerInput" rows="1" maxlength="2000" enterkeyhint="send" placeholder="${adminAllChatsMode?"Написать в чат от имени администратора":viewerRole==="guarantor"?"Написать участникам сделки":viewerRole==="seller"?t("write_buyer"):t("write_seller")}">${escapeHtml(chatDrafts.get(active.id)||"")}</textarea><button id="messengerSend" type="button" aria-label="${t("send")}" title="${t("send")}"><span aria-hidden="true">➤</span></button></div>`}`;
  const back=document.querySelector("#messengerBack");if(back)back.onclick=()=>{activeThreadId=null;conversationPanel=null;conversationPanelThreadId=null;renderMessenger()};
  document.querySelector("#closeMessengerConversation").onclick=closeMessenger;
  document.querySelectorAll("[data-conversation-panel]").forEach(button=>button.onclick=()=>toggleConversationPanel(active.id,button.dataset.conversationPanel));
  const closeConversationPanel=document.querySelector("#closeConversationPanel");if(closeConversationPanel)closeConversationPanel.onclick=()=>toggleConversationPanel(active.id,activePanel);
  const blockChatUser=document.querySelector("#blockChatUser");if(blockChatUser)blockChatUser.onclick=()=>setChatUserBlocked(active,!partnerBlocked);
  const chatProfile=document.querySelector("[data-chat-profile]");if(chatProfile)chatProfile.onclick=()=>openPublicProfile(+chatProfile.dataset.chatProfile);
  const sellerPhoto=document.querySelector("#conversationSellerPhoto");if(sellerPhoto)sellerPhoto.onclick=()=>openScreenshotViewer(item,0);
  const unblockChatUser=document.querySelector("#unblockChatUser");if(unblockChatUser)unblockChatUser.onclick=()=>setChatUserBlocked(active,false);
  const changeMethodButton=document.querySelector("#changeThreadMethod");if(changeMethodButton)changeMethodButton.onclick=()=>{methodPickerThreadId=methodPickerThreadId===active.id?null:active.id;renderMessenger()};
  const callAdminButton=document.querySelector("#callAdminButton");if(callAdminButton)callAdminButton.onclick=()=>openAdminHelpDialog(active.id);
  const resolveAdminCall=document.querySelector("#resolveAdminCall");if(resolveAdminCall)resolveAdminCall.onclick=()=>resolveAdminHelp(active.id);
  const cancelMethod=document.querySelector("#cancelMethodChange");if(cancelMethod)cancelMethod.onclick=()=>{methodPickerThreadId=null;renderMessenger()};
  document.querySelectorAll("[data-new-method]").forEach(button=>button.onclick=()=>changeThreadMethod(active.id,button.dataset.newMethod));
   document.querySelectorAll("[data-deal-action]").forEach(button=>button.onclick=()=>{
    const action=button.dataset.dealAction;
    if(action==="start")startEscrowDeal(active);
    else if(action==="start_guarantor")startEscrowDeal(active,"guarantor");
    else if(action==="start_collateral")startEscrowDeal(active,"collateral");
    else if(action==="start_trust")startEscrowDeal(active,"direct");
    else performDealAction(active,action);
   });
  const sendButton=document.querySelector("#messengerSend"),messageInput=document.querySelector("#messengerInput");
  if(sendButton&&messageInput){
   const fitComposer=()=>{
    messageInput.style.height="auto";
    messageInput.style.height=`${Math.min(messageInput.scrollHeight,112)}px`;
   };
   const send=()=>sendMessengerMessage(active.id);
   sendButton.onclick=send;
   messageInput.oninput=()=>{chatDrafts.set(active.id,messageInput.value);fitComposer()};
   messageInput.onkeydown=event=>{
    if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();send()}
   };
   fitComposer();
   if(restoreComposerFocus){
    messageInput.focus({preventScroll:true});
    const start=Math.min(restoreComposerSelection?.[0]??messageInput.value.length,messageInput.value.length);
    const end=Math.min(restoreComposerSelection?.[1]??start,messageInput.value.length);
    messageInput.setSelectionRange(start,end);
   }
  }
  document.querySelector("#messengerMessages").scrollTop=9999;
 }
 document.querySelectorAll("[data-thread-id]").forEach(button=>button.onclick=()=>{
  activeThreadId=button.dataset.threadId;
  conversationPanel=null;
  conversationPanelThreadId=null;
  renderMessenger();
  const selected=chatThreads.find(thread=>thread.id===activeThreadId);
  if(selected?.compact){
   void loadExchangeThreadDetail(selected.id).then(()=>{
    if(activeThreadId===selected.id)renderMessenger();
   }).catch(error=>console.error("exchange thread detail",error));
  }
 });
 renderChatBadge();
}
async function changeThreadMethod(threadId,mode){
 const thread=chatThreads.find(candidate=>candidate.id===threadId);
 if(!thread||threadViewerRole(thread)!=="buyer")return;
 const item=threadItem(thread);
 if(!item||thread.mode===mode)return;
 try{
  const data=await exchangeFetch("/api/exchange/threads/method",{
   method:"POST",body:JSON.stringify({thread_id:threadId,method:mode})
  });
  replaceThread(data.thread);
  dealSelections.set(dealContextKey(item.id),mode);
  methodPickerThreadId=null;
  if(selectedId===item.id)openDeal(item.id);
  renderMessenger();
 }catch(error){alert(`Не удалось изменить способ: ${error.message}`)}
}
async function sendMessengerMessage(threadId){
 const input=document.querySelector("#messengerInput");
 const text=(input?.value||chatDrafts.get(threadId)||"").trim();
 if(!text)return;
 chatDrafts.delete(threadId);
 if(input)input.value="";
 try{
  const data=await exchangeFetch("/api/exchange/threads/message",{
   method:"POST",body:JSON.stringify({thread_id:threadId,text})
  });
  replaceThread(data.thread);
  renderMessenger();
 }catch(error){
  chatDrafts.set(threadId,text);
  if(input)input.value=text;
  alert(`Не удалось отправить сообщение: ${error.message}`);
 }
}
const brainrotSearch=document.querySelector("#brainrotSearch"),brainrotSuggestions=document.querySelector("#brainrotSuggestions"),selectedBrainrotsBox=document.querySelector("#selectedBrainrots");
function renderSelectedBrainrots(){
 selectedBrainrotsBox.innerHTML=selectedBrainrots.map(entry=>`<span class="selected-brainrot">${escapeHtml(entry.name)}<button type="button" data-remove-brainrot="${escapeHtml(entry.id)}">×</button></span>`).join("");
 selectedBrainrotsBox.querySelectorAll("[data-remove-brainrot]").forEach(button=>button.onclick=()=>{
  selectedBrainrots=selectedBrainrots.filter(entry=>entry.id!==button.dataset.removeBrainrot);renderSelectedBrainrots();
 });
}
function renderBrainrotSuggestions(){
 const query=brainrotSearch.value.trim().toLowerCase();
 if(!query){brainrotSuggestions.classList.add("hidden");return}
 const matchRank=name=>{
  const lower=name.toLowerCase();
  if(lower.startsWith(query))return 0;
  if(lower.split(/\s+/).some(word=>word.startsWith(query)))return 1;
  return 2;
 };
 const matches=brainrotCatalog
  .filter(name=>isStandaloneBrainrotName(name)&&name.toLowerCase().includes(query))
  .sort((a,b)=>matchRank(a)-matchRank(b)||a.localeCompare(b))
  .slice(0,12);
 brainrotSuggestions.innerHTML=matches.length?matches.map(name=>{const income=incomeRecord(name);return `<button type="button" class="brainrot-suggestion" data-brainrot="${encodeURIComponent(name)}"><span>${escapeHtml(name)}</span>${income?`<small>${escapeHtml(income.income)}/s</small>`:""}</button>`}).join(""):`<div class="brainrot-suggestion">${t("nothing_found")}</div>`;
 brainrotSuggestions.classList.remove("hidden");
 brainrotSuggestions.querySelectorAll("[data-brainrot]").forEach(button=>button.onclick=()=>{
  selectedBrainrots.push({id:`selection-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,name:decodeURIComponent(button.dataset.brainrot)});brainrotSearch.value="";renderSelectedBrainrots();renderBrainrotSuggestions();brainrotSearch.focus();
 });
}
const traitsCacheKey="brainbet_exchange_traits_v2";
let traits=[];
try{
 const cachedTraits=JSON.parse(localStorage.getItem(traitsCacheKey));
 if(Array.isArray(cachedTraits)&&cachedTraits.length)traits=cachedTraits;
}catch(error){}
let traitsLoadState=traits.length?"ready":"loading";
let mutations=[],mutationsLoadState="loading";
const traitEditor=document.querySelector("#traitEditor"),traitTargetName=document.querySelector("#traitTargetName"),traitSearch=document.querySelector("#traitSearch"),traitSuggestions=document.querySelector("#traitSuggestions"),selectedTraitsBox=document.querySelector("#selectedTraits"),mutationOptionsBox=document.querySelector("#mutationOptions"),incomePreview=document.querySelector("#incomePreview");
const traitsByBrainrot=new Map();
const mutationByBrainrot=new Map();
const quantityByBrainrot=new Map();
let activeBrainrotId="";
function createSelectedBrainrot(name,quantity=1){
 const entry={id:`selection-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,name};
 selectedBrainrots.push(entry);
 setQuantity(entry.id,quantity);
 return entry;
}
function selectedBrainrotById(id){return selectedBrainrots.find(entry=>entry.id===id)||null}
function getTraits(id){if(!traitsByBrainrot.has(id))traitsByBrainrot.set(id,[]);return traitsByBrainrot.get(id)}
function getMutationName(id){return mutationByBrainrot.get(id)||null}
function getQuantity(id){return Math.max(1,Number.parseInt(quantityByBrainrot.get(id),10)||1)}
function setQuantity(id,value){quantityByBrainrot.set(id,Math.min(999,Math.max(1,Number.parseInt(value,10)||1)))}
function renderSelectedBrainrotsWithTraits(){
 const variants=new Map();
 selectedBrainrotsBox.innerHTML=selectedBrainrots.map(entry=>{
  const {id,name}=entry;
  const safeId=escapeHtml(id),safeName=escapeHtml(name);
  const variant=(variants.get(name)||0)+1;
  variants.set(name,variant);
  const duplicates=selectedBrainrots.filter(item=>item.name===name).length;
  const mutationName=getMutationName(id),mutation=mutations.find(item=>item.name===mutationName),income=brainrotIncomeCalculation(name,mutationName,getTraits(id)),quantity=getQuantity(id);
  return `<span class="selected-brainrot"><span class="brainrot-main"><b>${safeName}${duplicates>1?` <small class="variant-label">${language==="ru"?"ВАРИАНТ":"VARIANT"} ${variant}</small>`:""}</b><span class="brainrot-attributes">${mutation?`<i class="mutation-summary"><img src="${escapeHtml(mutation.image)}" alt="">${escapeHtml(mutation.name)}</i>`:""}<span class="trait-count">${getTraits(id).length?`${getTraits(id).length} ${t("trait_count")}`:t("no_traits_selected")}</span>${income?`<strong class="selected-income">${formatIncomeRange(income.income*quantity,income.incomeMax*quantity)}</strong>`:""}</span></span><span class="quantity-control"><button type="button" data-quantity-minus="${safeId}">−</button><label><small>${language==="ru"?"ОДИНАКОВЫХ":"SAME SET"}</small><input type="number" min="1" max="999" inputmode="numeric" value="${quantity}" data-quantity-input="${safeId}"></label><button type="button" data-quantity-plus="${safeId}">＋</button></span><button class="trait-action" type="button" data-open-traits="${safeId}">${t("item_setup")}</button><button class="remove-brainrot" type="button" data-remove-brainrot="${safeId}">×</button>${variant===duplicates?`<button class="add-brainrot-variant" type="button" data-add-variant="${safeId}">＋ ${language==="ru"?"ДРУГОЙ НАБОР БАФОВ":"DIFFERENT BUFF SET"}</button>`:""}</span>`;
 }).join("");
 selectedBrainrotsBox.querySelectorAll("[data-remove-brainrot]").forEach(button=>button.onclick=()=>{const id=button.dataset.removeBrainrot;selectedBrainrots=selectedBrainrots.filter(item=>item.id!==id);traitsByBrainrot.delete(id);mutationByBrainrot.delete(id);quantityByBrainrot.delete(id);if(activeBrainrotId===id)closeTraitEditor();renderSelectedBrainrotsWithTraits();renderBrainrotSuggestions()});
 selectedBrainrotsBox.querySelectorAll("[data-open-traits]").forEach(button=>button.onclick=()=>openTraitEditor(button.dataset.openTraits));
 selectedBrainrotsBox.querySelectorAll("[data-quantity-minus]").forEach(button=>button.onclick=()=>{const id=button.dataset.quantityMinus;setQuantity(id,getQuantity(id)-1);renderSelectedBrainrotsWithTraits()});
 selectedBrainrotsBox.querySelectorAll("[data-quantity-plus]").forEach(button=>button.onclick=()=>{const id=button.dataset.quantityPlus;setQuantity(id,getQuantity(id)+1);renderSelectedBrainrotsWithTraits()});
 selectedBrainrotsBox.querySelectorAll("[data-quantity-input]").forEach(input=>input.onchange=()=>{setQuantity(input.dataset.quantityInput,input.value);renderSelectedBrainrotsWithTraits()});
 selectedBrainrotsBox.querySelectorAll("[data-add-variant]").forEach(button=>button.onclick=()=>{const source=selectedBrainrotById(button.dataset.addVariant);if(!source)return;const entry=createSelectedBrainrot(source.name);renderSelectedBrainrotsWithTraits();openTraitEditor(entry.id)});
}
function openTraitEditor(id){const entry=selectedBrainrotById(id);if(!entry)return;activeBrainrotId=id;traitTargetName.textContent=`${t("item_config")}: ${entry.name}`;traitSearch.value="";traitEditor.classList.remove("hidden");renderTraitEditor();traitSearch.focus()}
function closeTraitEditor(){activeBrainrotId="";traitEditor.classList.add("hidden")}
function renderIncomePreview(){
 const entry=selectedBrainrotById(activeBrainrotId);
 if(!entry)return;
 const result=brainrotIncomeCalculation(entry.name,getMutationName(activeBrainrotId),getTraits(activeBrainrotId));
 if(!result){
  incomePreview.innerHTML=`<span>${t("income_unknown")}</span>`;
  return;
 }
 const quantity=getQuantity(activeBrainrotId);
 incomePreview.innerHTML=`
  <span><small>${t("base_income")}</small><b>${result.baseLabel}</b></span>
  <span><small>${t("total_multiplier")}</small><b>${Number(result.totalMultiplier.toFixed(2))}${result.totalMultiplierMax!==result.totalMultiplier?`–${Number(result.totalMultiplierMax.toFixed(2))}`:""}×</b></span>
  <span class="income-total"><small>${t("income_per_second")} × ${quantity}</small><b>${formatIncomeRange(result.income*quantity,result.incomeMax*quantity)}</b></span>`;
}
function renderMutationOptions(){
 if(!activeBrainrotId)return;
 if(mutationsLoadState==="loading"){
  mutationOptionsBox.innerHTML=`<div class="mutation-loading"><span></span></div>`;
  return;
 }
 if(mutationsLoadState==="error"){
  mutationOptionsBox.innerHTML=`<div class="mutation-error">${t("traits_load_error")}</div>`;
  return;
 }
 const selectedName=getMutationName(activeBrainrotId)||"Default";
 mutationOptionsBox.innerHTML=mutations.map((mutation,index)=>`<label class="mutation-option ${selectedName===mutation.name?"selected":""}">
  <input type="radio" name="mutation-choice" data-mutation-index="${index}" ${selectedName===mutation.name?"checked":""}>
  <img src="${escapeHtml(mutation.image)}" alt="${escapeHtml(mutation.name)}">
  <span><b>${mutation.name==="Default"?t("no_mutation"):escapeHtml(mutation.name)}</b><small>${escapeHtml(mutation.multiplier)} · ${escapeHtml(mutation.category)}</small></span>
 </label>`).join("");
 mutationOptionsBox.querySelectorAll("[data-mutation-index]").forEach(input=>input.onchange=()=>{
  const mutation=mutations[+input.dataset.mutationIndex];
  if(mutation.name==="Default")mutationByBrainrot.delete(activeBrainrotId);
  else mutationByBrainrot.set(activeBrainrotId,mutation.name);
  renderSelectedBrainrotsWithTraits();
  renderMutationOptions();
  renderIncomePreview();
 });
}
function renderTraitEditor(){
 if(!activeBrainrotId)return;
 renderMutationOptions();
 renderIncomePreview();
 if(traitsLoadState==="loading"&&!traits.length){
  traitSuggestions.innerHTML=`<div class="trait-loading"><span></span>${t("loading_traits")}</div>`;
  selectedTraitsBox.innerHTML="";
  return;
 }
 if(traitsLoadState==="error"&&!traits.length){
  traitSuggestions.innerHTML=`<div class="trait-load-error">${t("traits_load_error")}</div>`;
  selectedTraitsBox.innerHTML="";
  return;
 }
 const selected=new Set(getTraits(activeBrainrotId)),query=traitSearch.value.trim().toLowerCase();
 const visibleTraits=traits.map((trait,index)=>({trait,index})).filter(({trait})=>!query||`${trait.name} ${trait.category}`.toLowerCase().includes(query));
 traitSuggestions.innerHTML=visibleTraits.map(({trait,index})=>`<label class="trait-option ${selected.has(trait.name)?"selected":""}">
  <input class="trait-checkbox" type="checkbox" data-trait-index="${index}" ${selected.has(trait.name)?"checked":""}>
  <span class="trait-icon">${trait.image?`<img src="${escapeHtml(trait.image)}" alt="${escapeHtml(trait.name)}">`:escapeHtml(trait.icon||"•")}</span>
  <span class="trait-option-copy"><b>${escapeHtml(trait.name)}</b><small>${escapeHtml(trait.category)} · ${escapeHtml(trait.multiplier||trait.mult)}</small></span>
 </label>`).join("")||`<div>${t("no_traits")}</div>`;
 selectedTraitsBox.innerHTML=getTraits(activeBrainrotId).map(name=>{const trait=traits.find(item=>item.name===name);return `<span class="trait-pill">${trait?.image?`<img src="${escapeHtml(trait.image)}" alt="">`:escapeHtml(trait?.icon||"•")} ${escapeHtml(name)}<button type="button" data-remove-trait="${encodeURIComponent(name)}">×</button></span>`}).join("");
 traitSuggestions.querySelectorAll("[data-trait-index]").forEach(checkbox=>checkbox.onchange=()=>{
  const name=traits[+checkbox.dataset.traitIndex].name;
  const list=getTraits(activeBrainrotId);
  traitsByBrainrot.set(activeBrainrotId,checkbox.checked?[...new Set([...list,name])]:list.filter(item=>item!==name));
  renderSelectedBrainrotsWithTraits();
  renderTraitEditor();
 });
 selectedTraitsBox.querySelectorAll("[data-remove-trait]").forEach(button=>button.onclick=()=>{const list=getTraits(activeBrainrotId),removed=decodeURIComponent(button.dataset.removeTrait);traitsByBrainrot.set(activeBrainrotId,list.filter(name=>name!==removed));renderSelectedBrainrotsWithTraits();renderTraitEditor()});
}
renderSelectedBrainrots=renderSelectedBrainrotsWithTraits;
const oldRenderBrainrotSuggestions=renderBrainrotSuggestions;
renderBrainrotSuggestions=function(){oldRenderBrainrotSuggestions();document.querySelectorAll("#brainrotSuggestions [data-brainrot]").forEach(button=>button.onclick=()=>{const entry=createSelectedBrainrot(decodeURIComponent(button.dataset.brainrot));brainrotSearch.value="";renderSelectedBrainrotsWithTraits();renderBrainrotSuggestions();openTraitEditor(entry.id)})};
brainrotSearch.oninput=renderBrainrotSuggestions;
traitSearch.oninput=renderTraitEditor;
document.querySelector("#closeTraitEditor").onclick=closeTraitEditor;
fetch("/exchange/traits.json?v=20260811-61").then(response=>{
 if(!response.ok)throw new Error(`HTTP ${response.status}`);
 return response.json();
}).then(parsed=>{
 traits=parsed.map(item=>({...item,image:String(item.image||"").replace(/^static\//,"../")}));
 traitsLoadState="ready";
 localStorage.setItem(traitsCacheKey,JSON.stringify(traits));
 renderTraitEditor();
 renderFilterTraitOptions();
 render();
}).catch(error=>{
 console.warn("traits.json",error);
 traitsLoadState="error";
 renderTraitEditor();
});
fetch("/exchange/mutations.json").then(response=>{
 if(!response.ok)throw new Error(`HTTP ${response.status}`);
 return response.json();
}).then(parsed=>{
 mutations=parsed.map(item=>({...item,image:String(item.image||"").replace(/^static\//,"../")}));
 mutationsLoadState="ready";
 renderSelectedBrainrotsWithTraits();
 renderMutationOptions();
 renderFilterMutationOptions();
 render();
}).catch(error=>{
 console.warn("mutations.json",error);
 mutationsLoadState="error";
 renderMutationOptions();
});
fetch("/exchange/incomes.json?v=20260811-61").then(response=>{
 if(!response.ok)throw new Error(`HTTP ${response.status}`);
 return response.json();
}).then(parsed=>{
 brainrotIncomes=parsed;
 brainrotIncomeByName=new Map(parsed.map(item=>[item.name.toLowerCase(),item]));
 renderSelectedBrainrotsWithTraits();
 renderTraitEditor();
 render();
}).catch(error=>console.warn("incomes.json",error));
document.querySelector("#languageToggle").onclick=()=>{language=language==="ru"?"en":"ru";localStorage.setItem("exchange_language",language);applyLanguage()};
document.querySelector("#displayCurrencySelect").value=displayCashCurrency;
document.querySelector("#displayCurrencySelect").onchange=event=>setDisplayCashCurrency(event.target.value);
document.addEventListener("click",event=>{if(!event.target.closest(".brainrot-picker"))brainrotSuggestions.classList.add("hidden")});
fetch("/exchange/catalog.json?v=20260811-61").then(response=>response.json()).then(parsed=>{
 brainrotCatalog=[...new Set([...brainrotCatalog,...parsed])]
  .filter(name=>name!=="brainbet-arcade-reference"&&isStandaloneBrainrotName(name))
  .sort((a,b)=>a.localeCompare(b));
}).catch(()=>{});
["search","filterSeller","filterBrainsMin","filterBrainsMax","filterStarsMin","filterStarsMax","filterCashMin","filterCashMax","filterIncomeMin","filterIncomeMax","filterItemsMin","filterItemsMax","filterQuantityMin","filterQuantityMax"].forEach(id=>{
 const input=document.querySelector(`#${id}`);if(input)input.oninput=render;
});
document.querySelector("#filterCashCurrency").onchange=render;
document.querySelector("#sort").onchange=render;
document.querySelectorAll("[data-filter-method]").forEach(input=>input.onchange=()=>{
 if(input.checked)exchangeFilters.methods.add(input.dataset.filterMethod);else exchangeFilters.methods.delete(input.dataset.filterMethod);
 render();
});
document.querySelectorAll("[data-filter-intent]").forEach(button=>button.onclick=()=>{
 exchangeFilters.intent=button.dataset.filterIntent;
 syncExchangeFilterControls();
 render();
});
const filterToggleMap={filterAllMethods:"allMethods",filterExact:"exact",filterScreenshots:"screenshots",filterHasMutation:"hasMutation",filterHasTraits:"hasTraits",filterNoMutation:"noMutation",filterNoTraits:"noTraits",filterStrictCashCurrency:"strictCashCurrency",filterMultipleMethods:"multipleMethods"};
Object.entries(filterToggleMap).forEach(([id,key])=>{document.querySelector(`#${id}`).onchange=event=>{
 exchangeFilters[key]=event.target.checked;
 if(key==="noMutation"&&exchangeFilters.noMutation){exchangeFilters.hasMutation=false;exchangeFilters.mutation=""}
 if(key==="hasMutation"&&exchangeFilters.hasMutation)exchangeFilters.noMutation=false;
 if(key==="noTraits"&&exchangeFilters.noTraits){exchangeFilters.hasTraits=false;exchangeFilters.traits.clear()}
 if(key==="hasTraits"&&exchangeFilters.hasTraits)exchangeFilters.noTraits=false;
 syncExchangeFilterControls();render();
}});
document.querySelectorAll("[data-structure]").forEach(button=>button.onclick=()=>{exchangeFilters.structure=button.dataset.structure;syncExchangeFilterControls();render()});
document.querySelectorAll("[data-trait-mode]").forEach(button=>button.onclick=()=>{exchangeFilters.traitMode=button.dataset.traitMode;syncExchangeFilterControls();render()});
document.querySelectorAll("[data-trait-selection-mode]").forEach(button=>button.onclick=()=>{exchangeFilters.traitSelectionMode=button.dataset.traitSelectionMode;syncExchangeFilterControls()});
document.querySelector("#filterMutation").onchange=event=>{
 exchangeFilters.mutation=event.target.value;
 if(exchangeFilters.mutation){exchangeFilters.noMutation=false;if(exchangeFilters.excludedMutation===exchangeFilters.mutation)exchangeFilters.excludedMutation=""}
 syncExchangeFilterControls();render();
};
document.querySelector("#filterExcludedMutation").onchange=event=>{
 exchangeFilters.excludedMutation=event.target.value;
 if(exchangeFilters.excludedMutation===exchangeFilters.mutation)exchangeFilters.mutation="";
 syncExchangeFilterControls();render();
};
document.querySelector("#filterTraitSearch").oninput=renderFilterTraitOptions;
document.querySelector("#resetFilters").onclick=resetExchangeFilters;
document.querySelector("#applyMobileFilters").onclick=closeMobilePanels;
document.querySelectorAll(".tab").forEach(b=>b.onclick=()=>{
 document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
 b.classList.add("active");
 activeTab=b.dataset.tab;
 document.querySelectorAll("[data-mobile-action]").forEach(item=>item.classList.toggle("active",item.dataset.mobileAction===activeTab));
 const titles={market:t("fresh_offers"),wanted:t("wanted_title"),mine:t("mine_title"),saved:t("saved_title")};
 document.querySelector("#feedTitle").textContent=titles[activeTab];
 render();
});
function renderAccounts(){
 document.querySelector("#accountBalance").textContent=`${currentAccount.balance.toLocaleString("ru-RU")} 🧠`;
 const reserveBadge=document.querySelector("#reserveWalletBadge");
 const totalReserve=Number(currentAccount.reservedBrains||0);
 const compactReserve=totalReserve>=1000000?`${(totalReserve/1000000).toFixed(totalReserve>=10000000?0:1)}M`:totalReserve>=1000?`${(totalReserve/1000).toFixed(totalReserve>=10000?0:1)}K`:String(totalReserve);
 reserveBadge.textContent=compactReserve;
 reserveBadge.dataset.empty=totalReserve?"false":"true";
 document.querySelector("#adminConsoleBtn").classList.toggle("hidden",!currentAccount.isAdmin);
}
function renderReserveWallet(){
 const total=Math.max(0,Number(currentAccount.reservedBrains||0));
 const available=Math.max(0,Number(currentAccount.availableReserveBrains||0));
 const held=Math.max(0,total-available);
 const pending=Math.max(0,Number(currentAccount.pendingReserveWithdrawalBrains||0));
 const requests=currentAccount.reserveWithdrawalRequests||[];
 const withdrawalSupported=Boolean(exchangeCapabilities.reserveWithdrawalReview);
 const wager=currentAccount.wager||{};
 const wagerLocked=wager.unlocked===false;
 document.querySelector("#reserveWalletTotal").textContent=`${formatNumber(total)} 🧠`;
 document.querySelector("#reserveWalletAvailable").textContent=`${formatNumber(available)} 🧠`;
 document.querySelector("#reserveWalletHeld").textContent=`${formatNumber(held)} 🧠`;
 document.querySelector("#reserveWalletPending").textContent=`${formatNumber(pending)} 🧠`;
 document.querySelector("#reserveWalletBalance").textContent=`${formatNumber(currentAccount.balance)} 🧠`;
 const depositButton=document.querySelector("#reserveWalletDeposit");
 depositButton.disabled=wagerLocked;
 depositButton.title=wagerLocked?`Сначала отыграй ещё ${formatNumber(wager.remaining||0)} 🧠`:"";
 const withdrawButton=document.querySelector("#reserveWalletWithdraw");
 withdrawButton.disabled=!withdrawalSupported||available<=0||pending>0;
 withdrawButton.textContent=!withdrawalSupported?"НУЖЕН ПЕРЕЗАПУСК СЕРВЕРА":pending>0?"ЗАЯВКА УЖЕ НА РАССМОТРЕНИИ":"ОТПРАВИТЬ ЗАЯВКУ";
 document.querySelector("#reserveRequestHistory").innerHTML=requests.length?`<small>ПОСЛЕДНИЕ ЗАЯВКИ</small>${requests.slice(0,5).map(request=>{
  const labels={pending:"НА РАССМОТРЕНИИ",approved:"ОДОБРЕНО",rejected:"ОТКЛОНЕНО"};
  return `<div class="reserve-request-row ${request.status}"><span><b>Заявка #${request.id}</b><small>${new Date(request.requestedAt).toLocaleString("ru-RU")}</small></span><strong>${formatNumber(request.amount)} 🧠</strong><em>${labels[request.status]||request.status}</em></div>`;
 }).join("")}`:"";
}
function openReserveWallet(){
 renderReserveWallet();
 const status=document.querySelector("#reserveWalletStatus");
 const withdrawalSupported=Boolean(exchangeCapabilities.reserveWithdrawalReview);
 status.textContent=withdrawalSupported?"":"Новая система заявок ещё не запущена на сервере. Перезапусти mini_app.py.";
 status.classList.toggle("error",!withdrawalSupported);
 const wager=currentAccount.wager||{};
 if(wager.unlocked===false){
  status.textContent=`Сначала заверши отыгрыш: осталось ${formatNumber(wager.remaining||0)} 🧠. После этого можно добавлять мозги в резерв и использовать их в сделках.`;
  status.classList.add("error");
 }
 document.querySelector("#reserveDepositInput").value="";
 document.querySelector("#reserveWithdrawInput").value="";
 document.querySelector("#reserveWallet").classList.remove("hidden");
}
function closeReserveWallet(){document.querySelector("#reserveWallet").classList.add("hidden")}
async function updateReserveWallet(action){
 const input=document.querySelector(action==="deposit"?"#reserveDepositInput":"#reserveWithdrawInput");
 const status=document.querySelector("#reserveWalletStatus");
 const amount=Math.floor(Number(input.value));
 if(action==="withdraw"&&!exchangeCapabilities.reserveWithdrawalReview){
  status.textContent="Сервер работает на старом API. Перезапусти mini_app.py, затем отправь заявку заново.";
  status.classList.add("error");
  return;
 }
 if(!Number.isFinite(amount)||amount<=0){
  status.textContent="Введи целое положительное количество мозгов.";
  status.classList.add("error");
  return;
 }
 status.textContent="Обновляем резерв...";
 status.classList.remove("error");
 try{
  const data=await exchangeFetch("/api/exchange/reserve",{
   method:"POST",
   body:JSON.stringify({action,amount})
  });
  if(action==="withdraw"&&!data.withdrawalRequest){
   throw new Error("Сервер не создал заявку. Перезапусти mini_app.py и повтори снятие.");
  }
  currentAccount.balance=Number(data.balance||0);
  currentAccount.reservedBrains=Number(data.reservedBrains||0);
  currentAccount.availableReserveBrains=Number(data.availableReserveBrains||0);
  currentAccount.pendingReserveWithdrawalBrains=Number(data.pendingReserveWithdrawalBrains||0);
  if(data.withdrawalRequest){
   currentAccount.reserveWithdrawalRequests=[data.withdrawalRequest,...(currentAccount.reserveWithdrawalRequests||[])];
  }
  input.value="";
  renderAccounts();
  renderReserveWallet();
  await loadExchangeState({quiet:true});
  renderReserveWallet();
  render();
  status.textContent=action==="deposit"
   ?`${formatNumber(amount)} 🧠 добавлено в публичный резерв.`
   :`Заявка на снятие ${formatNumber(amount)} 🧠 отправлена администратору.`;
 }catch(error){
  status.textContent=dealErrorText(error);
  status.classList.add("error");
 }
}
const modal=document.querySelector("#modal");
const screenshotInput=document.querySelector("#screenshotInput"),screenshotDrop=document.querySelector("#screenshotDrop"),screenshotPreviews=document.querySelector("#screenshotPreviews");
const MAX_SCREENSHOTS_PER_LISTING=6;
const MAX_SCREENSHOT_BYTES=6*1024*1024;
const MAX_SCREENSHOTS_TOTAL_BYTES=10*1024*1024;
let selectedScreenshots=[];
let editingListingId=null;
let listingIntent="sell";
function setListingIntent(nextIntent){
 listingIntent=nextIntent==="buy"?"buy":"sell";
 document.querySelectorAll("[data-listing-intent]").forEach(button=>button.classList.toggle("active",button.dataset.listingIntent===listingIntent));
 const buying=listingIntent==="buy";
 const copy={
  listingIntentNote:buying?"Выбери предметы, которые хочешь найти. Откликнувшийся игрок станет продавцом.":"Выбери предметы, которые предлагаешь другим игрокам.",
  brainrotFieldLabel:buying?"ЧТО ХОЧЕШЬ КУПИТЬ":"ЧТО ПРОДАЁШЬ",
  dealTypePrompt:buying?"КАК ГОТОВ ЗАПЛАТИТЬ":"КАК ГОТОВ ПОЛУЧИТЬ ОПЛАТУ",
  cashPriceLabel:buying?"БЮДЖЕТ ПОКУПКИ":"ЦЕНА ПРОДАЖИ",
  brainPriceLabel:buying?"БЮДЖЕТ В МОЗГАХ BRAINBET":"ЦЕНА В МОЗГАХ BRAINBET",
  starsPriceLabel:buying?"БЮДЖЕТ В TELEGRAM STARS":"ЦЕНА В TELEGRAM STARS",
  tradeFieldLabel:buying?"ЧТО ПРЕДЛОЖИШЬ В ОБМЕН":"НА ЧТО ГОТОВ ОБМЕНЯТЬ"
 };
 Object.entries(copy).forEach(([id,text])=>{const node=document.querySelector(`#${id}`);if(node)node.textContent=text});
}
function renderScreenshotPreviews(){
 screenshotPreviews.innerHTML=selectedScreenshots.map((shot,index)=>`<figure><img src="${escapeHtml(shot.url)}" alt="${escapeHtml(shot.file.name)}"><button type="button" data-remove-shot="${index}" aria-label="Удалить">×</button><figcaption>${escapeHtml(shot.file.name)}</figcaption></figure>`).join("");
 screenshotPreviews.querySelectorAll("[data-remove-shot]").forEach(button=>button.onclick=event=>{
  event.stopPropagation();
  selectedScreenshots.splice(+button.dataset.removeShot,1);
  renderScreenshotPreviews();
 });
}
function fileToStoredImage(file){
 return new Promise((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=reject;
  reader.onload=()=>{
   const image=new Image();
   image.onerror=()=>resolve(reader.result);
   image.onload=()=>{
    const maxSide=960,scale=Math.min(1,maxSide/Math.max(image.width,image.height));
    const canvas=document.createElement("canvas");
    canvas.width=Math.max(1,Math.round(image.width*scale));
    canvas.height=Math.max(1,Math.round(image.height*scale));
    canvas.getContext("2d").drawImage(image,0,0,canvas.width,canvas.height);
    resolve(canvas.toDataURL("image/webp",.74));
   };
   image.src=reader.result;
  };
  reader.readAsDataURL(file);
 });
}
function storedImageBytes(dataUrl){
 if(!String(dataUrl||"").startsWith("data:"))return 0;
 const encoded=String(dataUrl).split(",",2)[1]||"";
 return Math.floor(encoded.length*3/4)-((encoded.match(/=*$/)||[""])[0].length);
}
async function addScreenshotFiles(files){
 const available=MAX_SCREENSHOTS_PER_LISTING-selectedScreenshots.length;
 const validFiles=[...files].filter(file=>["image/jpeg","image/png","image/webp","image/gif"].includes(file.type));
 const tooMany=validFiles.length>available;
 const accepted=validFiles.slice(0,available);
 screenshotDrop.classList.add("loading");
 try{
  let totalBytes=selectedScreenshots.reduce((sum,shot)=>sum+storedImageBytes(shot.url),0);
  let rejected=false;
  for(const file of accepted){
   const url=await fileToStoredImage(file);
   const storedBytes=storedImageBytes(url);
   if(storedBytes>MAX_SCREENSHOT_BYTES||totalBytes+storedBytes>MAX_SCREENSHOTS_TOTAL_BYTES){rejected=true;continue}
   totalBytes+=storedBytes;
   selectedScreenshots.push({file,url});
  }
   if(tooMany)alert("В одном объявлении можно загрузить не больше 6 скриншотов.");
   else if(rejected)alert("Один скриншот должен весить не больше 6 МБ, а все скриншоты вместе — не больше 10 МБ.");
 }finally{
  screenshotDrop.classList.remove("loading");
  screenshotInput.value="";
  renderScreenshotPreviews();
 }
}
document.querySelector("#chooseScreenshots").onclick=()=>screenshotInput.click();
screenshotInput.onchange=()=>addScreenshotFiles(screenshotInput.files);
["dragenter","dragover"].forEach(type=>screenshotDrop.addEventListener(type,event=>{event.preventDefault();screenshotDrop.classList.add("dragging")}));
["dragleave","drop"].forEach(type=>screenshotDrop.addEventListener(type,event=>{event.preventDefault();screenshotDrop.classList.remove("dragging")}));
screenshotDrop.addEventListener("drop",event=>addScreenshotFiles(event.dataTransfer.files));
function closeModal(event){if(event)event.preventDefault();modal.classList.add("hidden");modal.style.display="none"}
function openModal(){modal.style.display="flex";modal.classList.remove("hidden")}
function setDealField(typeId,fieldId,enabled,value=""){
 const checkbox=document.querySelector(typeId);
 checkbox.checked=enabled;
 document.querySelector(fieldId).classList.toggle("hidden",!enabled);
}
function resetListingEditor(){
 editingListingId=null;
 setListingIntent("sell");
 selectedBrainrots=[];
 traitsByBrainrot.clear();
 mutationByBrainrot.clear();
 quantityByBrainrot.clear();
 selectedScreenshots=[];
 closeTraitEditor();
 document.querySelector("#brainrotSearch").value="";
 setDealField("#typeCash","#cashFields",false);
 setDealField("#typeBrains","#brainsFields",false);
 setDealField("#typeStars","#starsFields",false);
 setDealField("#typeTrade","#tradeFields",false);
 document.querySelector("#newCash").value="";
 document.querySelector("#newCashCurrency").value="RUB";
 document.querySelector("#newCashCurrencyOnly").checked=false;
 document.querySelector("#newPrice").value="";
 document.querySelector("#newStars").value="";
 document.querySelector("#newTrade").value="";
 modal.querySelector("h2").textContent=t("create_offer");
 document.querySelector("#publishBtn").textContent=t("publish");
 renderSelectedBrainrotsWithTraits();
 renderScreenshotPreviews();
}
function beginListingEdit(item){
 editingListingId=item.id;
 setListingIntent(listingIntentOf(item));
 const brainrots=listingBrainrots(item);
 selectedBrainrots=[];
 traitsByBrainrot.clear();
 mutationByBrainrot.clear();
 quantityByBrainrot.clear();
 brainrots.forEach(brainrot=>{
  const entry=createSelectedBrainrot(brainrot.name,brainrot.quantity||1);
  traitsByBrainrot.set(entry.id,(brainrot.traits||[]).map(trait=>trait.name));
  if(brainrot.mutation?.name)mutationByBrainrot.set(entry.id,brainrot.mutation.name);
 });
 selectedScreenshots=(item.screenshots||[]).map(shot=>({file:{name:shot.name},url:shot.url}));
 setDealField("#typeCash","#cashFields",item.cash!=null,item.cash);
 setDealField("#typeBrains","#brainsFields",item.brains!=null,item.brains);
 setDealField("#typeStars","#starsFields",item.stars!=null,item.stars);
 setDealField("#typeTrade","#tradeFields",Boolean(item.trade),item.trade||"");
 document.querySelector("#newCash").value=item.cash??"";
 document.querySelector("#newCashCurrency").value=cashCurrency(item);
 document.querySelector("#newCashCurrencyOnly").checked=cashCurrencyOnly(item);
 document.querySelector("#newPrice").value=item.brains??"";
 document.querySelector("#newStars").value=item.stars??"";
 document.querySelector("#newTrade").value=item.trade||"";
 modal.querySelector("h2").textContent=t("edit_listing");
 document.querySelector("#publishBtn").textContent=t("save_changes");
 renderSelectedBrainrotsWithTraits();
 renderScreenshotPreviews();
 openModal();
 modal.querySelector(".modal-box").scrollTop=0;
}
const restrictedSellerStorageKey="brainbet_exchange_restricted_sellers_v1";
let restrictedSellers=new Set();
try{
 const savedRestricted=JSON.parse(localStorage.getItem(restrictedSellerStorageKey));
 if(Array.isArray(savedRestricted))restrictedSellers=new Set(savedRestricted);
}catch(error){}
const adminAuditStorageKey="brainbet_exchange_admin_audit_v1";
let adminAudit=[];
try{
 const savedAudit=JSON.parse(localStorage.getItem(adminAuditStorageKey));
 if(Array.isArray(savedAudit))adminAudit=savedAudit;
}catch(error){}
let adminTab="listings",adminQuery="";
function isAdmin(){return Boolean(currentAccount.isAdmin)}
function saveRestrictedSellers(){localStorage.setItem(restrictedSellerStorageKey,JSON.stringify([...restrictedSellers]))}
function addAdminAudit(action,target){
 adminAudit.unshift({id:Date.now(),admin:currentAccount.username,action,target,time:new Date().toLocaleString("ru-RU")});
 adminAudit=adminAudit.slice(0,200);
 localStorage.setItem(adminAuditStorageKey,JSON.stringify(adminAudit));
}
async function toggleListingPause(item){
 const restoring=pausedListingIds.has(item.id);
 try{
  await exchangeFetch("/api/exchange/listings/status",{
   method:"POST",body:JSON.stringify({id:item.id,status:restoring?"active":"paused"})
  });
 }catch(error){alert(`Не удалось изменить публикацию: ${error.message}`);return}
 if(restoring)pausedListingIds.delete(item.id);
 else pausedListingIds.add(item.id);
 item.status=restoring?"active":"paused";
 notifyListingThreads(item,restoring?"Объявление снова опубликовано":"Объявление снято с публикации и больше не действительно");
 if(isAdmin())addAdminAudit(pausedListingIds.has(item.id)?"Объявление скрыто":"Объявление восстановлено",`${item.name} · ${item.seller}`);
 selectedId=null;
 document.querySelector("#dealContent").classList.add("hidden");
 document.querySelector("#emptyDeal").classList.remove("hidden");
 render();
 if(!document.querySelector("#adminConsole").classList.contains("hidden"))renderAdminConsole();
}
function unpublishListing(item){if(!pausedListingIds.has(item.id))toggleListingPause(item)}
async function adminDeleteListing(item){
 if(!isAdmin())return;
 if(!confirm(`Удалить объявление «${item.name}»?`))return;
 try{
  await exchangeFetch("/api/exchange/listings/status",{
   method:"POST",body:JSON.stringify({id:item.id,status:"deleted"})
  });
 }catch(error){alert(`Не удалось удалить объявление: ${error.message}`);return}
 deletedListingIds.add(item.id);
 pausedListingIds.delete(item.id);
 saveDeletedListings();
 savePausedListings();
 notifyListingThreads(item,"Объявление удалено и больше не действительно");
 addAdminAudit("Объявление удалено",`${item.name} · ${item.seller}`);
 selectedId=null;
 document.querySelector("#dealContent").classList.add("hidden");
 document.querySelector("#emptyDeal").classList.remove("hidden");
 render();
 renderAdminConsole();
}
async function adminDeleteThread(thread){
 if(!isAdmin()||!confirm(`Удалить переписку ${thread.buyer} ↔ ${thread.seller}?`))return;
 try{
  await exchangeFetch("/api/exchange/admin/action",{
   method:"POST",body:JSON.stringify({action:"delete_thread",thread_id:thread.id})
  });
 }catch(error){alert(`Не удалось удалить переписку: ${error.message}`);return}
 chatThreads=chatThreads.filter(candidate=>candidate.id!==thread.id);
 saveChatThreads();
 addAdminAudit("Переписка удалена",`${thread.buyer} ↔ ${thread.seller}`);
 if(activeThreadId===thread.id)activeThreadId=null;
 renderAdminConsole();
 renderChatBadge();
}
async function adminToggleSeller(username){
 if(!isAdmin())return;
 const targetListing=items.find(item=>item.seller===username);
 const targetThread=chatThreads.find(thread=>thread.buyer===username||thread.seller===username);
 const targetId=targetListing?.seller_tg_id
  ||(targetThread?.buyer===username?targetThread?.buyer_tg_id:targetThread?.seller_tg_id)
  ||(username===currentAccount.username?currentAccount.tg_id:null);
 if(!targetId){alert("Не удалось определить Telegram ID игрока");return}
 const active=!restrictedSellers.has(username);
 try{
  await exchangeFetch("/api/exchange/admin/action",{
   method:"POST",body:JSON.stringify({action:"restrict_seller",target_tg_id:targetId,active})
  });
 }catch(error){alert(`Не удалось изменить ограничение: ${error.message}`);return}
 if(restrictedSellers.has(username))restrictedSellers.delete(username);
 else restrictedSellers.add(username);
 saveRestrictedSellers();
 items.filter(item=>item.seller===username).forEach(item=>notifyListingThreads(item,restrictedSellers.has(username)?"Объявление скрыто модерацией":"Ограничение снято, объявление снова доступно"));
 addAdminAudit(restrictedSellers.has(username)?"Публикации игрока ограничены":"Ограничение игрока снято",username);
 render();
 renderAdminConsole();
}
function renderGuarantorBadge(){
 const button=document.querySelector("#guarantorHubBtn"),badge=document.querySelector("#guarantorBadge");
 if(!button||!badge)return;
 const actionable=guaranteeDeals.filter(deal=>!terminalDealStatuses.has(deal.status)&&(
  deal.status==="seeking_guarantor"||Number(deal.guarantorTgId)===Number(currentAccount.tg_id)
 )).length;
 button.classList.toggle("hidden",!currentAccount.isGuarantor&&!currentAccount.isAdmin);
 badge.textContent=actionable;
 badge.classList.toggle("hidden",actionable===0);
}
function dealThread(deal){
 return chatThreads.find(thread=>String(thread.id)===String(deal.threadId));
}
function guaranteeActionLabel(deal){
 if(deal.status==="seeking_guarantor")return "Взять сделку";
 if(deal.status==="awaiting_cash")return "Ждём оплату";
 if(deal.status==="buyer_paid")return "Проверить оплату";
 if(deal.status==="cash_secured")return "Ждём предмет";
 if(deal.status==="awaiting_payout")return "Выплатить продавцу";
 return dealStateLabel(deal);
}
async function performGuaranteeAction(deal,action){
 if(action.startsWith("admin_")&&!confirmAdministrativeDealAction(deal,action))return;
 try{
  const result=await exchangeFetch("/api/exchange/deals/action",{method:"POST",body:JSON.stringify({deal_id:deal.id,action})});
  await loadExchangeState({quiet:true});
  if(action==="guarantor_accept"){
   closeGuaranteeConsole();
   adminAllChatsMode=false;
   openMessenger(String(result.thread?.id||deal.threadId));
   return;
  }
  renderGuaranteeConsole();
 }catch(error){alert(`Сделка не обновилась: ${error.message}`)}
}
function renderGuaranteeConsole(){
 const root=document.querySelector("#guaranteeConsole");
 if(!root||root.classList.contains("hidden"))return;
 const list=document.querySelector("#guaranteeDealList"),summary=document.querySelector("#guaranteeSummary");
 const waiting=guaranteeDeals.filter(deal=>deal.status==="seeking_guarantor").length;
 const mine=guaranteeDeals.filter(deal=>Number(deal.guarantorTgId)===Number(currentAccount.tg_id)).length;
 const disputes=guaranteeDeals.filter(deal=>deal.status==="disputed").length;
 summary.innerHTML=`<span>Ожидают гаранта<b>${waiting}</b></span><span>Мои сделки<b>${mine}</b></span><span>Споры<b>${disputes}</b></span>`;
 list.innerHTML=guaranteeDeals.length?guaranteeDeals.map(deal=>{
  const assigned=Number(deal.guarantorTgId)===Number(currentAccount.tg_id);
  const participant=[deal.buyerTgId,deal.sellerTgId].some(id=>Number(id)===Number(currentAccount.tg_id));
  const canTake=deal.status==="seeking_guarantor"&&(currentAccount.isGuarantor||currentAccount.isAdmin)&&!participant;
  const thread=dealThread(deal);
  const action=canTake?"guarantor_accept":deal.status==="awaiting_payout"&&assigned?"guarantor_payout":deal.status==="buyer_paid"&&assigned?"cash_secured":null;
  return `<article class="guarantee-card ${canTake||deal.status==="disputed"?"attention":""}">
   <div class="guarantee-card-head"><div><small>#${deal.id} · ${deal.method==="brains"?"ESCROW":"FIAT + GUARANTOR"}</small><h3>${escapeHtml(deal.listingName||"Сделка")}</h3></div><strong>${escapeHtml(guaranteeActionLabel(deal))}</strong></div>
   <p>${deal.method==="brains"?`${formatNumber(deal.amount)} 🧠`:deal.method==="stars"?`${formatNumber(deal.amount)} ★ Telegram Stars`:formatCashPrice(deal.amount,deal.currency||"RUB")}</p>
   <div class="guarantee-card-parties"><span>Покупатель<b>${escapeHtml(deal.buyer)}</b></span><span>Продавец<b>${escapeHtml(deal.seller)}</b></span></div>
   <div class="guarantee-actions">${action?dealButton(action,action==="guarantor_accept"?"Взять сделку":action==="guarantor_payout"?"Подтвердить выплату":"Подтвердить оплату","primary",deal.id):""}${thread?`<button type="button" data-guarantee-chat="${thread.id}">Открыть чат</button>`:""}${currentAccount.isAdmin?(deal.cashFlow==="collateral"&&deal.collateral?.status==="held"?`${dealButton("admin_compensate","Компенсация","danger",deal.id)}${dealButton("admin_return_collateral","Вернуть залог","",deal.id)}`:deal.method==="brains"&&deal.escrowStatus==="held"?adminBrainDecisionButtons(deal,deal.id):deal.status==="disputed"?dealButton("admin_complete_cash","Завершить после проверки","primary",deal.id):""):""}</div>
  </article>`;
 }).join(""):`<div class="admin-empty">Активных сделок пока нет</div>`;
 list.querySelectorAll("[data-deal-action]").forEach(button=>button.onclick=()=>{
  const deal=guaranteeDeals.find(candidate=>String(candidate.id)===String(button.dataset.dealId));
  if(deal)performGuaranteeAction(deal,button.dataset.dealAction);
 });
 list.querySelectorAll("[data-guarantee-chat]").forEach(button=>button.onclick=()=>{closeGuaranteeConsole();adminAllChatsMode=Boolean(currentAccount.isAdmin);openMessenger(button.dataset.guaranteeChat)});
}
function openGuaranteeConsole(){
 if(!currentAccount.isGuarantor&&!currentAccount.isAdmin)return;
 document.querySelector("#guaranteeConsole").classList.remove("hidden");
 renderGuaranteeConsole();
}
function closeGuaranteeConsole(){document.querySelector("#guaranteeConsole")?.classList.add("hidden")}
let adminGuarantorNotice="";
function adminSettingNumber(value){
 const normalized=String(value??"").trim().replace(/[\s\u00a0]+/g,"").replace(",",".");
 return normalized===""?0:Number(normalized);
}
async function adminSetGuarantor(targetId, active, maxDealRub){
 if(!isAdmin())return;
 const numericTarget=Number(targetId);
 if(adminGuarantorSaving.has(numericTarget))return;
 adminGuarantorLimitDrafts.set(numericTarget,String(maxDealRub??"0"));
 const parsedFee=8,parsedLimit=adminSettingNumber(maxDealRub);
 if(!Number.isFinite(parsedFee)||parsedFee<0||parsedFee>100){alert("Комиссия должна быть от 0 до 100%.");return}
 if(!Number.isFinite(parsedLimit)||parsedLimit<0){alert("Лимит должен быть положительным числом или 0.");return}
 adminGuarantorSaving.add(numericTarget);
 try{
  const result=await exchangeFetch("/api/exchange/admin/action",{method:"POST",body:JSON.stringify({action:"set_guarantor",target_tg_id:numericTarget,active:Boolean(active),fee_percent:parsedFee,max_deal_rub:parsedLimit})});
  const saved=result.guarantor||{};
  const index=exchangeGuarantors.findIndex(entry=>Number(entry.tg_id)===numericTarget);
  const next={...(index>=0?exchangeGuarantors[index]:{}),tg_id:numericTarget,active:Boolean(saved.active??active),feePercent:Number(saved.feePercent??parsedFee),maxDealRub:Number(saved.maxDealRub??parsedLimit)};
  if(index>=0)exchangeGuarantors.splice(index,1,next);else exchangeGuarantors.push(next);
  adminGuarantorNotice=`Сохранено: комиссия ${Number(saved.feePercent??parsedFee).toLocaleString("ru-RU")}% · лимит ${Number(saved.maxDealRub??parsedLimit)>0?`${formatNumber(saved.maxDealRub??parsedLimit)} RUB`:"без лимита"}`;
  adminGuarantorLimitDrafts.delete(numericTarget);
  await loadExchangeState({quiet:true});
  renderAdminConsole();
 }catch(error){alert(`Не удалось изменить гаранта: ${error.message}`)}
 finally{adminGuarantorSaving.delete(numericTarget)}
}
function openAdminConversation(threadId){
 if(!isAdmin())return;
 closeAdminConsole();
 adminAllChatsMode=true;
 openMessenger(threadId);
}
async function loadAdminThreadPage({reset=false}={}){
 if(!isAdmin()||!["calls","chats"].includes(adminTab))return;
 const callsOnly=adminTab==="calls",query=adminQuery.trim(),mode=`${adminTab}:${query}`;
 if(adminThreadsLoading&&!reset)return;
 if(reset||adminThreadMode!==mode){
  adminThreadMode=mode;
  adminThreadResultIds=[];
  adminThreadPage={offset:0,limit:100,total:0,nextOffset:0,hasMore:false,query,callsOnly};
 }
 const offset=adminThreadPage.nextOffset||0,token=++adminThreadLoadToken;
 adminThreadsLoading=true;
 renderAdminConsole();
 try{
  const params=new URLSearchParams({offset:String(offset),limit:String(adminThreadPage.limit||100)});
  if(query)params.set("q",query);
  if(callsOnly)params.set("calls","1");
  const data=await exchangeFetch(`/api/exchange/admin/threads?${params}`);
  if(token!==adminThreadLoadToken||adminThreadMode!==mode)return;
  const loadedIds=[];
  (data.threads||[]).forEach(thread=>loadedIds.push(replaceThread(thread).id));
  adminThreadResultIds=[...new Set([...adminThreadResultIds,...loadedIds])];
  adminThreadPage={...adminThreadPage,...(data.threadPage||{})};
 }catch(error){
  if(token===adminThreadLoadToken)alert(`Не удалось загрузить чаты: ${error.message}`);
 }finally{
  if(token===adminThreadLoadToken){adminThreadsLoading=false;renderAdminConsole()}
 }
}
function openAdminConsole(){
 if(!isAdmin())return;
 adminAllChatsMode=false;
 document.querySelector("#adminConsole").classList.remove("hidden");
 renderAdminConsole();
 if(["calls","chats"].includes(adminTab))void loadAdminThreadPage({reset:true});
}
function closeAdminConsole(){document.querySelector("#adminConsole").classList.add("hidden")}
async function reviewReserveWithdrawal(requestId,decision){
 const request=reserveWithdrawalRequests.find(entry=>Number(entry.id)===Number(requestId));
 if(!request||request.status!=="pending")return;
 const actionLabel=decision==="approve"?"ОДОБРИТЬ":"ОТКЛОНИТЬ";
 if(!confirm(`${actionLabel} снятие ${formatNumber(request.amount)} 🧠 для ${request.username}?`))return;
 try{
  await exchangeFetch("/api/exchange/admin/reserve-withdrawal",{
   method:"POST",body:JSON.stringify({request_id:request.id,decision})
  });
  await loadExchangeState({quiet:true});
  renderAdminConsole();
 }catch(error){alert(dealErrorText(error))}
}
function renderAdminConsole(){
 if(!isAdmin()){closeAdminConsole();return}
 const content=document.querySelector("#adminContent"),query=adminQuery.trim().toLowerCase();
 document.querySelectorAll("[data-admin-tab]").forEach(button=>button.classList.toggle("active",button.dataset.adminTab===adminTab));
 let resultCount=0;
 if(adminTab==="listings"){
  const listings=items.filter(item=>!deletedListingIds.has(item.id)&&(!query||`${item.name} ${item.seller} ${item.id}`.toLowerCase().includes(query)));
  resultCount=listings.length;
  content.innerHTML=`<div class="admin-list">${listings.map(item=>`<article class="admin-row">
   <div class="admin-row-cover">${listingMedia(item,"chat")}</div>
   <div class="admin-row-copy"><small>#${item.id} · ${pausedListingIds.has(item.id)?"СКРЫТО":"ОПУБЛИКОВАНО"}</small><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.seller)} · ${formatOfferCount(offerCount(item))}</span></div>
   <div class="admin-actions"><button data-admin-open="${item.id}">Открыть</button><button data-admin-edit="${item.id}">Редактировать</button><button data-admin-pause="${item.id}">${pausedListingIds.has(item.id)?"Вернуть":"Скрыть"}</button><button class="danger" data-admin-delete="${item.id}">Удалить</button></div>
  </article>`).join("")||`<div class="admin-empty">Объявлений не найдено</div>`}</div>`;
 }else if(adminTab==="calls"){
  const mode=`calls:${adminQuery.trim()}`,threads=adminThreadMode===mode?adminThreadResultIds.map(id=>chatThreads.find(thread=>thread.id===id)).filter(Boolean):[];
  resultCount=Number(adminThreadPage.total||threads.length);
  content.innerHTML=`<div class="admin-list">${threads.map(thread=>{const item=threadItem(thread),last=thread.messages.filter(message=>message.author!=="system").at(-1);return `<article class="admin-row admin-call-row">
   <span class="admin-call-mark">!</span><div class="admin-row-copy"><small>ВЫЗВАЛ ${escapeHtml(thread.adminRequest?.by||"Пользователь")} · ${new Date(thread.adminRequest?.createdAt||Date.now()).toLocaleString("ru-RU")}</small><b>${escapeHtml(thread.buyer)} ↔ ${escapeHtml(thread.seller)}</b><strong class="admin-call-reason">${escapeHtml(thread.adminRequest?.reason||"Причина не указана")}</strong><span>${escapeHtml(thread.listingName||item?.name||"Удалённое объявление")} · ${escapeHtml(last?.text||"Сообщений нет")}</span></div>
   <div class="admin-actions"><button data-admin-chat="${thread.id}">Открыть переписку</button><button class="success" data-admin-resolve="${thread.id}">Закрыть вызов</button></div>
  </article>`}).join("")||(adminThreadsLoading?`<div class="admin-empty">Загружаем вызовы…</div>`:`<div class="admin-empty">Активных вызовов администратора нет</div>`)}${adminThreadPage.hasMore?`<button class="admin-page-more" id="adminThreadsMore" type="button" ${adminThreadsLoading?"disabled":""}>${adminThreadsLoading?"ЗАГРУЗКА…":`ЗАГРУЗИТЬ ЕЩЁ · ${Math.max(0,adminThreadPage.total-adminThreadResultIds.length)}`}</button>`:""}</div>`;
 }else if(adminTab==="chats"){
  const mode=`chats:${adminQuery.trim()}`,threads=adminThreadMode===mode?adminThreadResultIds.map(id=>chatThreads.find(thread=>thread.id===id)).filter(Boolean):[];
  resultCount=Number(adminThreadPage.total||threads.length);
  content.innerHTML=`<div class="admin-list">${threads.map(thread=>{const item=threadItem(thread),last=thread.messages.at(-1);return `<article class="admin-row admin-chat-row">
   <span class="admin-chat-mark">✉</span><div class="admin-row-copy"><small>${escapeHtml(thread.listingName||item?.name||"Удалённое объявление")}</small><b>${escapeHtml(thread.buyer)} ↔ ${escapeHtml(thread.seller)}</b><span>${escapeHtml(last?.text||"Сообщений нет")} · ${escapeHtml(last?.time||"")}</span></div>
   <div class="admin-actions"><button data-admin-chat="${thread.id}">Читать</button><button class="danger" data-admin-chat-delete="${thread.id}">Удалить чат</button></div>
  </article>`}).join("")||(adminThreadsLoading?`<div class="admin-empty">Загружаем переписки…</div>`:`<div class="admin-empty">Переписок не найдено</div>`)}${adminThreadPage.hasMore?`<button class="admin-page-more" id="adminThreadsMore" type="button" ${adminThreadsLoading?"disabled":""}>${adminThreadsLoading?"ЗАГРУЗКА…":`ЗАГРУЗИТЬ ЕЩЁ · ${Math.max(0,adminThreadPage.total-adminThreadResultIds.length)}`}</button>`:""}</div>`;
 }else if(adminTab==="users"){
  const usernames=[...new Set([currentAccount.username,...adminUsers.map(user=>user.username),...items.map(item=>item.seller),...chatThreads.flatMap(thread=>[thread.buyer,thread.seller])])].filter(username=>username&&(!query||username.toLowerCase().includes(query)));
  resultCount=usernames.length;
 content.innerHTML=`<div class="admin-list">${usernames.map(username=>{const listingCount=items.filter(item=>item.seller===username&&!deletedListingIds.has(item.id)).length,chatCount=chatThreads.filter(thread=>thread.buyer===username||thread.seller===username).length;return `<article class="admin-row admin-user-row">
   <span class="admin-user-avatar">${escapeHtml(username.replace("@","")[0]?.toUpperCase()||"?")}</span><div class="admin-row-copy"><small>ИГРОК</small><b>${escapeHtml(username)}</b><span>${listingCount} объявлений · ${chatCount} переписок</span></div>
   <div class="admin-actions"><button class="${restrictedSellers.has(username)?"success":""}" data-admin-restrict="${encodeURIComponent(username)}">${restrictedSellers.has(username)?"Разрешить публикации":"Запретить публикации"}</button></div>
  </article>`}).join("")}</div>`;
 }else if(adminTab==="deals"){
  const deals=guaranteeDeals.filter(deal=>!query||`${deal.id} ${deal.listingName} ${deal.buyer} ${deal.seller} ${deal.status}`.toLowerCase().includes(query));
  resultCount=deals.length;
  content.innerHTML=`<div class="admin-list">${deals.map(deal=>`<article class="admin-row admin-chat-row">
   <span class="admin-deal-mark">${deal.method==="brains"?"🧠":deal.method==="stars"?"★":cashCurrencies[deal.currency||"RUB"]?.symbol||"¤"}</span><div class="admin-row-copy"><small>#${deal.id} · ${deal.method==="brains"?"ESCROW":deal.cashFlow==="collateral"?"ЗАЛОГ":deal.cashFlow==="trust"?"ДОВЕРИЕ":"ГАРАНТ"}</small><b>${escapeHtml(deal.listingName||"Сделка")}</b><span>${escapeHtml(deal.buyer)} ↔ ${escapeHtml(deal.seller)} · ${deal.method==="brains"?`${formatNumber(deal.amount)} 🧠`:deal.method==="stars"?`${formatNumber(deal.amount)} ★`:formatCashPrice(deal.amount,deal.currency||"RUB")} · ${escapeHtml(dealStateLabel(deal))}</span></div>
   <div class="admin-actions">${dealThread(deal)?`<button data-admin-deal-chat="${deal.threadId}">Открыть чат</button>`:""}${deal.cashFlow==="collateral"&&deal.collateral?.status==="held"?`<button class="danger" data-admin-deal-action="${deal.id}" data-action="admin_compensate">Компенсировать</button><button data-admin-deal-action="${deal.id}" data-action="admin_return_collateral">Вернуть залог</button>`:deal.method==="brains"&&deal.escrowStatus==="held"?adminBrainConsoleButtons(deal):deal.status!=="completed"?`<button class="danger" data-admin-deal-action="${deal.id}" data-action="${deal.status==="disputed"?"admin_complete_cash":"admin_cancel"}">${deal.status==="disputed"?"Завершить после проверки":"Отменить сделку"}</button>`:""}</div>
  </article>`).join("")||`<div class="admin-empty">Активных сделок нет</div>`}</div>`;
 }else if(adminTab==="reserve"){
  const requests=reserveWithdrawalRequests.filter(request=>!query||`${request.id} ${request.tgId} ${request.username} ${request.amount} ${request.status}`.toLowerCase().includes(query));
  resultCount=requests.length;
  const statusLabels={pending:"НА РАССМОТРЕНИИ",approved:"ОДОБРЕНО",rejected:"ОТКЛОНЕНО"};
  content.innerHTML=`<div class="admin-reserve-summary"><span><small>ОЖИДАЮТ РЕШЕНИЯ</small><b>${requests.filter(request=>request.status==="pending").length}</b></span><span><small>СУММА В ЗАЯВКАХ</small><b>${formatNumber(requests.filter(request=>request.status==="pending").reduce((sum,request)=>sum+Number(request.amount||0),0))} 🧠</b></span></div><div class="admin-list">${requests.map(request=>`<article class="admin-row admin-reserve-row ${request.status}">
   <span class="admin-reserve-mark">◆</span><div class="admin-row-copy"><small>ЗАЯВКА #${request.id} · ${statusLabels[request.status]||request.status}</small><b>${escapeHtml(request.username||`user${request.tgId}`)}</b><span>ID ${request.tgId} · ${new Date(request.requestedAt).toLocaleString("ru-RU")}${request.reviewer?` · ${escapeHtml(request.reviewer)}`:""}</span></div><strong class="admin-reserve-amount">${formatNumber(request.amount)} 🧠</strong>
   ${request.status==="pending"?`<div class="admin-actions"><button class="success" data-reserve-review="${request.id}" data-decision="approve">ОДОБРИТЬ И ЗАЧИСЛИТЬ</button><button class="danger" data-reserve-review="${request.id}" data-decision="reject">ОТКЛОНИТЬ И ВЕРНУТЬ В РЕЗЕРВ</button></div>`:""}
  </article>`).join("")||`<div class="admin-empty">Заявок на снятие пока нет</div>`}</div>`;
 }else if(adminTab==="guarantors"){
  const rows=adminUsers.filter(user=>!query||`${user.tg_id} ${user.username}`.toLowerCase().includes(query));
  resultCount=rows.length;
  content.innerHTML=`<section class="admin-guarantor-guide"><div><small>КАК НАЗНАЧИТЬ ГАРАНТА</small><b>Найди игрока по нику или Telegram ID</b><span>Укажи максимальную сумму одной сделки, затем нажми «Назначить гарантом».</span></div><ol><li><i>1</i>Найти игрока</li><li><i>2</i>Задать лимит</li><li><i>3</i>Назначить</li></ol></section>${adminGuarantorNotice?`<div class="admin-save-notice">✓ ${escapeHtml(adminGuarantorNotice)}</div>`:""}<div class="admin-list admin-guarantor-list">${rows.map(user=>{const guard=exchangeGuarantors.find(candidate=>Number(candidate.tg_id)===Number(user.tg_id));const limitValue=adminGuarantorLimitDrafts.has(Number(user.tg_id))?adminGuarantorLimitDrafts.get(Number(user.tg_id)):(guard?.maxDealRub||0);return `<article class="admin-guarantor-row ${guard?.active?"active":""}" data-guarantor-row="${user.tg_id}">
   <header class="admin-guarantor-person"><span class="admin-user-avatar">${escapeHtml((user.username||"?").replace("@","")[0]?.toUpperCase()||"?")}</span><div><small>${guard?.active?"ГАРАНТ РАБОТАЕТ":"ОБЫЧНЫЙ ПОЛЬЗОВАТЕЛЬ"}</small><b>${escapeHtml(user.username)}</b><em>ID ${user.tg_id}</em></div><i>${guard?.active?"ON":"OFF"}</i></header>
   <div class="admin-guarantor-stats"><span><small>ЗАВЕРШЕНО</small><b>${formatNumber(guard?.completedDeals||0)}</b></span><span><small>КОМИССИЯ</small><b>${Number(guard?.feePercent||0).toLocaleString("ru-RU")}%</b></span><span><small>ЛИМИТ</small><b>${guard?.maxDealRub?`${formatNumber(guard.maxDealRub)} ₽`:"БЕЗ ЛИМИТА"}</b></span></div>
   <div class="guarantor-settings"><label><span>Комиссия гаранта</span><div><input inputmode="decimal" type="text" value="${guard?.feePercent||8}" data-guarantor-fee="${user.tg_id}"><i>%</i></div><small>Гарант получит 8% в мозгах, минимум 30 🧠 за сделку.</small></label><label><span>Максимальная сумма сделки</span><div><input inputmode="decimal" type="text" value="${escapeHtml(limitValue)}" data-guarantor-limit="${user.tg_id}"><i>RUB</i></div><small>Оставь 0, если персонального лимита нет.</small></label></div>
   <footer class="admin-guarantor-actions">${guard?.active?`<button class="success" data-guarantor-save="${user.tg_id}">Сохранить настройки</button><button class="danger" data-guarantor-toggle="${user.tg_id}">Снять роль</button>`:`<button class="success" data-guarantor-toggle="${user.tg_id}">Назначить гарантом</button>`}</footer>
  </article>`}).join("")||`<div class="admin-empty">Пользователей нет</div>`}</div>`;
 }else{
  const entries=adminAudit.filter(entry=>!query||`${entry.action} ${entry.target} ${entry.admin}`.toLowerCase().includes(query));
  resultCount=entries.length;
  content.innerHTML=`<div class="admin-audit">${entries.map(entry=>`<article><time>${escapeHtml(entry.time)}</time><div><b>${escapeHtml(entry.action)}</b><span>${escapeHtml(entry.target)}</span></div><small>${escapeHtml(entry.admin)}</small></article>`).join("")||`<div class="admin-empty">Действий пока нет</div>`}</div>`;
 }
 document.querySelector("#adminResultCount").textContent=`${resultCount}`;
 renderAdminAlertBadge();
 content.querySelectorAll("[data-admin-open]").forEach(button=>button.onclick=()=>{const id=+button.dataset.adminOpen;closeAdminConsole();openDeal(id)});
 content.querySelectorAll("[data-admin-edit]").forEach(button=>button.onclick=()=>{const item=items.find(candidate=>candidate.id===+button.dataset.adminEdit);if(item){addAdminAudit("Открыт редактор объявления",`${item.name} · ${item.seller}`);closeAdminConsole();beginListingEdit(item)}});
 content.querySelectorAll("[data-admin-pause]").forEach(button=>button.onclick=()=>{const item=items.find(candidate=>candidate.id===+button.dataset.adminPause);if(item)toggleListingPause(item)});
 content.querySelectorAll("[data-admin-delete]").forEach(button=>button.onclick=()=>{const item=items.find(candidate=>candidate.id===+button.dataset.adminDelete);if(item)adminDeleteListing(item)});
 content.querySelectorAll("[data-admin-chat]").forEach(button=>button.onclick=()=>openAdminConversation(button.dataset.adminChat));
 const adminThreadsMore=content.querySelector("#adminThreadsMore");if(adminThreadsMore)adminThreadsMore.onclick=()=>void loadAdminThreadPage();
 content.querySelectorAll("[data-admin-resolve]").forEach(button=>button.onclick=async()=>{await resolveAdminHelp(button.dataset.adminResolve);renderAdminConsole()});
 content.querySelectorAll("[data-admin-chat-delete]").forEach(button=>button.onclick=()=>{const thread=chatThreads.find(candidate=>candidate.id===button.dataset.adminChatDelete);if(thread)adminDeleteThread(thread)});
 content.querySelectorAll("[data-admin-restrict]").forEach(button=>button.onclick=()=>adminToggleSeller(decodeURIComponent(button.dataset.adminRestrict)));
 content.querySelectorAll("[data-guarantee-chat]").forEach(button=>button.onclick=()=>{closeGuaranteeConsole();openAdminConversation(button.dataset.guaranteeChat)});
 content.querySelectorAll("[data-admin-deal-chat]").forEach(button=>button.onclick=()=>openAdminConversation(button.dataset.adminDealChat));
 content.querySelectorAll("[data-admin-deal-action]").forEach(button=>button.onclick=()=>{const deal=guaranteeDeals.find(candidate=>String(candidate.id)===String(button.dataset.adminDealAction));if(deal)performGuaranteeAction(deal,button.dataset.action)});
 content.querySelectorAll("[data-reserve-review]").forEach(button=>button.onclick=()=>reviewReserveWithdrawal(button.dataset.reserveReview,button.dataset.decision));
 content.querySelectorAll("[data-guarantor-fee]").forEach(input=>{
  input.value="8";
  input.readOnly=true;
  input.tabIndex=-1;
  const label=input.closest("label"),title=label?.querySelector("span"),hint=label?.querySelector("small");
  if(title)title.textContent="Фиксированная комиссия";
  if(hint)hint.textContent="Оплата гаранту: 8% от сделки, но не меньше 30 мозгов.";
 });
 content.querySelectorAll("[data-guarantor-toggle]").forEach(button=>button.onclick=()=>{const id=Number(button.dataset.guarantorToggle),row=button.closest("[data-guarantor-row]"),guard=exchangeGuarantors.find(candidate=>Number(candidate.tg_id)===id),limit=row?.querySelector(`[data-guarantor-limit="${id}"]`)?.value||0;adminSetGuarantor(id,!guard?.active,limit)});
 content.querySelectorAll("[data-guarantor-save]").forEach(button=>button.onclick=()=>{const id=Number(button.dataset.guarantorSave),row=button.closest("[data-guarantor-row]"),limit=row?.querySelector(`[data-guarantor-limit="${id}"]`)?.value||0;adminSetGuarantor(id,true,limit)});
 content.querySelectorAll("[data-guarantor-limit]").forEach(input=>{
  const id=Number(input.dataset.guarantorLimit);
  input.addEventListener("input",()=>adminGuarantorLimitDrafts.set(id,input.value));
  input.addEventListener("keydown",event=>{if(event.key!=="Enter")return;event.preventDefault();input.blur();adminSetGuarantor(id,true,input.value)});
 });
}
window.closeExchangeModal=closeModal;
document.addEventListener("click",event=>{if(event.target.closest&&event.target.closest("#closeModal"))closeModal(event)},true);
document.querySelector("#createBtn").addEventListener("click",()=>{resetListingEditor();openModal()});
document.querySelector("#closeModal").addEventListener("click",closeModal);
modal.addEventListener("click",event=>{if(event.target===modal)closeModal()});
const messenger=document.querySelector("#messenger");
const exchangeTopbar=document.querySelector(".topbar");
const exchangeToolsToggle=document.querySelector("#exchangeToolsToggle");
function closeExchangeTools(){
 exchangeTopbar?.classList.remove("tools-open");
 exchangeToolsToggle?.setAttribute("aria-expanded","false");
}
exchangeToolsToggle?.addEventListener("click",event=>{
 event.stopPropagation();
 const opening=!exchangeTopbar.classList.contains("tools-open");
 exchangeTopbar.classList.toggle("tools-open",opening);
 exchangeToolsToggle.setAttribute("aria-expanded",String(opening));
});
document.addEventListener("click",event=>{if(exchangeTopbar?.classList.contains("tools-open")&&!event.target.closest(".topbar"))closeExchangeTools()});
document.querySelectorAll("#exchangeHeadActions button").forEach(button=>button.addEventListener("click",closeExchangeTools));
document.querySelector("#displayCurrencySelect")?.addEventListener("change",closeExchangeTools);
document.querySelector("#chatHubBtn").onclick=()=>{adminAllChatsMode=false;openMessenger(null,true)};
document.querySelector("#closeMessenger").onclick=closeMessenger;
document.querySelector("#chatSearch").oninput=event=>{chatQuery=event.target.value;renderMessenger()};
messenger.addEventListener("click",event=>{if(event.target===messenger)closeMessenger()});
document.querySelector("#adminConsoleBtn").onclick=openAdminConsole;
document.querySelector("#closeAdminConsole").onclick=closeAdminConsole;
document.querySelector("#adminConsole").addEventListener("click",event=>{if(event.target.id==="adminConsole")closeAdminConsole()});
document.querySelector("#guarantorHubBtn").onclick=openGuaranteeConsole;
document.querySelector("#closeGuaranteeConsole").onclick=closeGuaranteeConsole;
document.querySelector("#guaranteeConsole").addEventListener("click",event=>{if(event.target.id==="guaranteeConsole")closeGuaranteeConsole()});
document.querySelectorAll("[data-admin-tab]").forEach(button=>button.onclick=()=>{
 adminTab=button.dataset.adminTab;
 renderAdminConsole();
 if(["calls","chats"].includes(adminTab))void loadAdminThreadPage({reset:true});
});
document.querySelector("#adminSearch").oninput=event=>{
 adminQuery=event.target.value;
 clearTimeout(adminThreadSearchTimer);
 if(["calls","chats"].includes(adminTab)){
  adminThreadSearchTimer=setTimeout(()=>void loadAdminThreadPage({reset:true}),250);
  renderAdminConsole();
 }else renderAdminConsole();
};
const adminHelpDialog=document.querySelector("#adminHelpDialog"),adminHelpForm=document.querySelector("#adminHelpForm"),adminHelpDetails=document.querySelector("#adminHelpDetails");
document.querySelector("#adminHelpClose")?.addEventListener("click",closeAdminHelpDialog);
document.querySelector("#adminHelpCancel")?.addEventListener("click",closeAdminHelpDialog);
adminHelpDialog?.addEventListener("click",event=>{if(event.target===adminHelpDialog)closeAdminHelpDialog()});
adminHelpDetails?.addEventListener("input",()=>{const counter=document.querySelector("#adminHelpCounter");if(counter)counter.textContent=String(adminHelpDetails.value.length)});
adminHelpForm?.addEventListener("submit",event=>{
 event.preventDefault();
 const preset=String(document.querySelector("#adminHelpReason")?.value||"").trim(),details=String(adminHelpDetails?.value||"").trim(),error=document.querySelector("#adminHelpError");
 if(!preset){if(error)error.textContent="Выбери причину вызова.";return}
 if(preset==="Другое"&&details.length<3){if(error)error.textContent="Коротко опиши причину вызова.";adminHelpDetails?.focus();return}
 const reason=details?`${preset}: ${details}`:preset;
 void requestAdminHelp(pendingAdminHelpThreadId,reason);
});
document.addEventListener("keydown",event=>{if(event.key==="Escape"&&!adminHelpDialog?.classList.contains("hidden"))closeAdminHelpDialog()});
const mobileFilters=document.querySelector(".filters");
const mobileScrim=document.querySelector("#mobileScrim");
function closeMobilePanels(){
 mobileFilters?.classList.remove("mobile-open");
 document.querySelector("#dealPanel")?.classList.remove("mobile-open");
 document.body.classList.remove("mobile-panel-visible","deal-view-open");
}
document.querySelector("#mobileFiltersBtn")?.addEventListener("click",()=>{
 mobileFilters?.classList.add("mobile-open");
 document.body.classList.add("mobile-panel-visible");
});
document.querySelector("#mobileFiltersClose")?.addEventListener("click",closeMobilePanels);
document.querySelector("#mobileDealClose")?.addEventListener("click",()=>{
 document.querySelector("#dealPanel")?.classList.remove("mobile-open");
 document.body.classList.remove("mobile-panel-visible","deal-view-open");
});
mobileScrim?.addEventListener("click",closeMobilePanels);
document.querySelectorAll("[data-mobile-action]").forEach(button=>button.addEventListener("click",()=>{
 const action=button.dataset.mobileAction;
 if(action!=="chats"){
  closeExchangeTools();
  closeMessenger();
  closeReserveWallet();
  closeGuaranteeConsole();
  closeAdminConsole();
  closeMobilePanels();
 }
 if(action==="create"){resetListingEditor();openModal();return}
 if(action==="chats"){adminAllChatsMode=false;openMessenger(null,true);return}
 document.querySelectorAll("[data-mobile-action]").forEach(item=>item.classList.toggle("active",item===button));
 const target=document.querySelector(`.tab[data-tab="${action}"]`);
 if(target)target.click();
 window.scrollTo({top:0,behavior:"smooth"});
}));
const screenshotViewer=document.querySelector("#screenshotViewer");
document.querySelector("#screenshotViewerClose").onclick=closeScreenshotViewer;
document.querySelector("#screenshotViewerPrev").onclick=()=>moveScreenshotViewer(-1);
document.querySelector("#screenshotViewerNext").onclick=()=>moveScreenshotViewer(1);
screenshotViewer.addEventListener("click",event=>{if(event.target===screenshotViewer)closeScreenshotViewer()});
document.addEventListener("keydown",event=>{
 if(event.key==="Escape"){closeModal();closeMessenger();closeScreenshotViewer();closeAdminConsole();closeGuaranteeConsole();closeReserveWallet()}
 if(!screenshotViewer.classList.contains("hidden")&&event.key==="ArrowLeft")moveScreenshotViewer(-1);
 if(!screenshotViewer.classList.contains("hidden")&&event.key==="ArrowRight")moveScreenshotViewer(1);
});
const reserveWallet=document.querySelector("#reserveWallet");
document.querySelector("#reserveWalletBtn").onclick=openReserveWallet;
document.querySelector("#closeReserveWallet").onclick=closeReserveWallet;
document.querySelector("#reserveWalletDeposit").onclick=()=>updateReserveWallet("deposit");
document.querySelector("#reserveWalletWithdraw").onclick=()=>updateReserveWallet("withdraw");
reserveWallet.addEventListener("click",event=>{if(event.target===reserveWallet)closeReserveWallet()});
function bindToggle(id,fields){document.querySelector(id).onchange=e=>document.querySelector(fields).classList.toggle("hidden",!e.target.checked)}
bindToggle("#typeCash","#cashFields");bindToggle("#typeBrains","#brainsFields");bindToggle("#typeStars","#starsFields");bindToggle("#typeTrade","#tradeFields");
document.querySelectorAll("[data-listing-intent]").forEach(button=>button.onclick=()=>setListingIntent(button.dataset.listingIntent));
renderAccounts();render();renderChatBadge();
let listingPublishInFlight=false;
document.querySelector("#publishBtn").onclick=async()=>{
 if(listingPublishInFlight)return;
 if(!isAdmin()&&restrictedSellers.has(currentAccount.username)){alert("Администратор временно ограничил публикацию объявлений для этого аккаунта.");return}
 const cash=document.querySelector("#typeCash").checked?(+document.querySelector("#newCash").value||0):null;
 const cashCurrencyCode=document.querySelector("#newCashCurrency").value;
 const cashCurrencyOnlyValue=cash!==null&&document.querySelector("#newCashCurrencyOnly").checked;
 const brains=document.querySelector("#typeBrains").checked?(+document.querySelector("#newPrice").value||0):null;
 const stars=document.querySelector("#typeStars").checked?(Math.floor(+document.querySelector("#newStars").value)||0):null;
 const trade=document.querySelector("#typeTrade").checked?(document.querySelector("#newTrade").value||t("consider_offers")):null;
 if(cash===null&&brains===null&&stars===null&&trade===null){alert(t("choose_deal"));return}
 if(selectedBrainrots.length===0){alert(t("choose_brainrot"));return}
 const listingItems=selectedBrainrots.map(entry=>({
  name:entry.name,
  img:brainrotImagePath(entry.name),
  quantity:getQuantity(entry.id),
  mutation:(()=>{const mutation=mutations.find(item=>item.name===getMutationName(entry.id));return mutation?{name:mutation.name,image:mutation.image,multiplier:mutation.multiplier}:null})(),
  traits:getTraits(entry.id).map(traitName=>{const trait=traits.find(item=>item.name===traitName);return {name:traitName,image:trait?.image||"",multiplier:trait?.multiplier||trait?.mult||""}})
 }));
 const listingName=listingItems.map(item=>`${item.name}${item.quantity>1?` ×${item.quantity}`:""}`).join(" + ");
 const listingShots=selectedScreenshots.map(shot=>({name:shot.file.name,url:shot.url}));
 const editingIndex=editingListingId==null?-1:items.findIndex(item=>item.id===editingListingId);
 const previousItem=editingIndex>=0?items[editingIndex]:null;
 const draftItem={
  ...(previousItem||{}),
  id:previousItem?.id??null,
 name:listingName,
  intent:listingIntent,
 seller:previousItem?.seller||currentAccount.username,
  img:listingItems[0].img,
  brainrots:listingItems,
  screenshots:listingShots,
  cash,cashCurrency:cashCurrencyCode,cashCurrencyOnly:cashCurrencyOnlyValue,brains,stars,trade,
  offers:previousItem?.offers||0,
  custom:true,
  createdAt:previousItem?.createdAt||Date.now(),
  updatedAt:Date.now()
 };
 let nextItem;
 const publishButton=document.querySelector("#publishBtn");
 const publishButtonText=publishButton.textContent;
 listingPublishInFlight=true;
 publishButton.disabled=true;
 publishButton.setAttribute("aria-busy","true");
 publishButton.textContent=editingIndex>=0?"СОХРАНЕНИЕ...":"ПУБЛИКАЦИЯ...";
 try{
  const data=await exchangeFetch("/api/exchange/listings",{
   method:"POST",
   body:JSON.stringify({id:previousItem?.id||null,listing:draftItem})
  });
  nextItem=data.listing;
 }catch(error){
  console.error("exchange listing save",error.code||error.message,error.payload||error);
  const sizeErrors=new Set(["listing_too_large","screenshot_too_large","screenshots_too_large","too_many_screenshots"]);
  if(error.message==="listing_limit_reached")alert("Можно держать не больше 20 активных или скрытых объявлений. Сначала дождись удаления старых публикаций.");
  else alert(sizeErrors.has(error.message)?"Скриншоты слишком тяжёлые: максимум 6 МБ каждый и 10 МБ суммарно.":`Не удалось сохранить объявление: ${error.message}`);
  return;
 }finally{
  listingPublishInFlight=false;
  publishButton.disabled=false;
  publishButton.removeAttribute("aria-busy");
  publishButton.textContent=publishButtonText;
 }
 if(editingIndex>=0)items.splice(editingIndex,1,nextItem);
 else items.unshift(nextItem);
 pausedListingIds.delete(nextItem.id);
 resetListingEditor();
 closeModal();
 render();
 if(selectedId===nextItem.id)openDeal(nextItem.id);
};
applyLanguage();
