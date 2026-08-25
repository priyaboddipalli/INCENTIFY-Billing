const fs=require('fs'),path=require('path'),vm=require('vm');const root=path.resolve(__dirname,'..');let fail=0;function t(n,c){console.log((c?'PASS ':'FAIL ')+n);if(!c)fail++}
const erp=fs.readFileSync(path.join(root,'erp.html'),'utf8'),login=fs.readFileSync(path.join(root,'index.html'),'utf8'),adapter=fs.readFileSync(path.join(root,'js/web-adapter.js'),'utf8'),bridge=fs.readFileSync(path.join(root,'js/bridge-client.js'),'utf8'),config=fs.readFileSync(path.join(root,'js/config.js'),'utf8'),auth=fs.readFileSync(path.join(root,'js/auth.js'),'utf8'),admin=fs.readFileSync(path.join(root,'admin.html'),'utf8');
for(const file of ['js/config.js','js/bridge-client.js','js/auth.js','js/web-adapter.js']){try{new vm.Script(fs.readFileSync(path.join(root,file),'utf8'));t(file+' syntax parses',true)}catch(e){t(file+' syntax parses',false)}}
['Dashboard','New Invoice','Invoices','Payments','Payment Gateway','Customers','History','Finance','P&L','Balance Sheet','Business Settings'].forEach(x=>t('ERP retains '+x,erp.includes(x)));
t('separate login page comes first',login.includes('Secure sign in')&&login.includes('Approved email')&&!login.includes('page-dashboard'));
t('approved email + 6-digit OTP flow',login.includes('requestOtp')&&login.includes('verifyOtp')&&login.includes('/^[0-9]{6}$/'));
t('ERP requires authenticated bootstrap',adapter.includes("location.replace('index.html')")&&adapter.includes("A.call('bootstrap'"));
t('web adapter loads before original ERP inline application',erp.indexOf('js/web-adapter.js')<erp.indexOf('// ── ASSETS'));
['loadData','saveData','exportPDF','exportPaymentReceipt','exportExcel','exportFinanceReport','gatewayRequest','reserveInvoiceNumber','openExternal','copyText'].forEach(x=>t('web compatibility adapter '+x,adapter.includes(x+':')||adapter.includes(x+'(')));
t('central invoice reservation retained',erp.includes('reserveInvoiceNumber')&&erp.includes('Cloud invoice number could not be reserved'));
t('invoice print copies original ERP CSS',adapter.includes("querySelectorAll('style,link[rel=\"stylesheet\"]')"));
t('finance PDF workflow retained',adapter.includes('financeHtml')&&adapter.includes('INCENTIFY Finance Report'));
t('Apps Script URL configured',config.includes('script.google.com/macros/s/AKfycby1_'));
t('hidden iframe bridge transport used',bridge.includes('INCENTIFY_API_REQUEST')&&bridge.includes('contentWindow.postMessage')&&bridge.includes('event.source!==this.iframe.contentWindow'));
t('no direct google.script.run in GitHub frontend',![login,erp,adapter,bridge,config,auth,admin].some(x=>x.includes('google.script.run')));
t('admin UI has users/sessions/login/audit/issues',admin.includes('Users')&&admin.includes('Sessions')&&admin.includes('Login History')&&admin.includes('Audit Log')&&admin.includes('Issues'));
t('admin requires server-validated ADMIN role',auth.includes('requireAdmin')&&admin.includes('Auth.requireAdmin'));
t('desktop window controls hidden in web UI',erp.includes('.win-btn{display:none!important'));
t('web Razorpay description no longer says Windows secure storage',!erp.includes('Windows secure storage'));
t('no Electron/npm runtime dependency',!fs.existsSync(path.join(root,'package.json'))&&!erp.includes('INCENTIFY Billing Desktop v4.0.0'));
t('no obvious Razorpay production key literal committed',!/(rzp_(test|live)_[A-Za-z0-9]{8,})/.test([login,erp,adapter,config,auth,admin].join('\n')));
t('GitHub Pages marker exists',fs.existsSync(path.join(root,'.nojekyll')));
if(fail){console.error('\n'+fail+' verification(s) failed.');process.exit(1)}console.log('\nINCENTIFY GitHub frontend v5.1 verification passed.');
