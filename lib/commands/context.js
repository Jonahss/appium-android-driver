import _ from 'lodash';
import logger from '../logger';
import webviewHelpers from '../webview-helpers';
import Chromedriver from 'appium-chromedriver';
import { errors } from 'mobile-json-wire-protocol';
import { NATIVE_WIN, WEBVIEW_BASE, WEBVIEW_WIN, CHROMIUM_WIN } from '../webview-helpers';

let commands = {}, helpers = {}, extensions = {};

helpers.defaultContextName = function () {
  return NATIVE_WIN;
};

helpers.defaultWebviewName = function () {
  return WEBVIEW_BASE + this.opts.appPackage;
};

helpers.isWebContext = function () {
  return this.curContext !== null && this.curContext !== NATIVE_WIN;
};

function isChromedriverContext (viewName) {
  return viewName.indexOf(WEBVIEW_WIN) !== -1 || viewName === CHROMIUM_WIN;
}

helpers.startChromedriverProxy = async function (context) {
  logger.debug("Connecting to chrome-backed webview");
  if (this.chromedriver !== null) {
    throw new Error("We already have a chromedriver instance running");
  }

  let cd;
  if (this.sessionChromedrivers[context]) {
    // in the case where we've already set up a chromedriver for a context,
    // we want to reconnect to it, not create a whole new one
    cd = await this.setupExistingChromedriver(context);
  } else {
    cd = await this.setupNewChromedriver(context);
    // bind our stop/exit handler, passing in context so we know which
    // one stopped unexpectedly
    cd.on(Chromedriver.EVENT_CHANGED, (msg) => {
      if (msg.state === Chromedriver.STATE_STOPPED) {
        this.onChromedriverStop(context);
      }
    });
    // save the chromedriver object under the context
    this.sessionChromedrivers[context] = cd;
  }
  // hook up the local variables so we can proxy this biz
  this.chromedriver = cd;
  this.proxyReqRes = this.chromedriver.proxyReq.bind(this.chromedriver);
  this.jwpProxyActive = true;
};

helpers.suspendChromedriverProxy = function () {
  this.chromedriver = null;
  this.proxyReqRes = null;
  this.jwpProxyActive = false;
};

helpers.setupExistingChromedriver = async function (context) {
  logger.debug(`Found existing Chromedriver for context '${context}'. Using it.`);
  let chromedriver = this.sessionChromedrivers[context];

  // check the status by sending a simple window-based command to ChromeDriver
  // if there is an error, we want to recreate the ChromeDriver session
  if (!await chromedriver.hasWorkingWebview()) {
    logger.debug("ChromeDriver is not associated with a window. " +
                 "Re-initializing the session.");
    await chromedriver.restart();
  }
  return chromedriver;
};

helpers.setupNewChromedriver = async function (opts) {
  let chromeArgs = {
    port: opts.chromeDriverPort,
    executable: opts.chromedriverExecutable
  };
  let chromedriver = new Chromedriver(chromeArgs);
  let caps = {
    chromeOptions: {
      androidPackage: opts.appPackage,
      androidUseRunningApp: true
    }
  };
  if (opts.enablePerformanceLogging) {
    caps.loggingPrefs = {performance: 'ALL'};
  }
  caps = webviewHelpers.decorateChromeOptions(caps, this.opts, this.adb.curDeviceId);
  await chromedriver.start(caps);
};

helpers.onChromedriverStop = async function (context) {
  logger.warn(`Chromedriver for context ${context} stopped unexpectedly`);
  if (context === this.curContext) {
    // if we don't have a stop callback, we exited unexpectedly and so want
    // to shut down the session and respond with an error
    // TODO: this kind of thing should be emitted and handled by a higher-level
    // controlling function
    let err = new Error("Chromedriver quit unexpectedly during session");
    await this.startUnexpectedShutdown(err);
  } else if (context !== this.chromedriverRestartingContext) {
    // if a Chromedriver in the non-active context barfs, we don't really
    // care, we'll just make a new one next time we need the context.
    // The only time we ignore this is if we know we're in the middle of a
    // Chromedriver restart
    logger.warn("Chromedriver quit unexpectedly, but it wasn't the active " +
                "context, ignoring");
    delete this.sessionChromedrivers[context];
  }
};

helpers.stopChromedriverProxies = async function () {
  for (let context of _.keys(this.sessionChromedrivers)) {
    logger.debug(`Stopping chromedriver for context ${context}`);
    // stop listening for the stopped state event
    this.sessionChromedrivers[context].removeAllListeners(Chromedriver.EVENT_CHANGED);
    try {
      await this.sessionChromedrivers[context].stop();
    } catch (err) {
      logger.warn("Error stopping Chromedriver: " + err.message);
    }
    delete this.sessionChromedrivers[context];
  }
};

commands.getCurrentContext = async function () {
  return this.curContext;
};

commands.getContexts = async function () {
  let webviews = await webviewHelpers.getWebviews(this.adb,
      this.opts.androidDeviceSocket);
  this.contexts = _.union([NATIVE_WIN], webviews);
  logger.debug(`Available contexts: ${JSON.stringify(this.contexts)}`);
  return this.contexts;
};

commands.setContext = async function (name) {
  if (name === null) {
    name = this.defaultContextName();
  } else if (name === WEBVIEW_WIN) {
    // handle setContext "WEBVIEW"
    name = this.defaultWebviewName();
  }
  let contexts = await this.getContexts();
  // if the context we want doesn't exist, fail
  if (!_.contains(contexts, name)) {
    throw new errors.NoSuchContextError();
  }
  // if we're already in the context we want, do nothing
  if (name === this.curContext) {
    return;
  }

  // Otherwise, we have some options when it comes to webviews. If we want a
  // Chromedriver webview, we can only control one at a time.
  if (isChromedriverContext(name)) {
    // start proxying commands directly to chromedriver
    await this.startChromedriverProxy(name);
  } else if (isChromedriverContext(this.curContext)) {
    // if we're moving to a non-chromedriver webview, and our current context
    // _is_ a chromedriver webview, simply suspend proxying to the latter
    this.suspendChromedriverProxy();
  } else {
    throw new Error(`Didn't know how to handle switching to context '${name}'`);
  }
  this.curContext = name;
};

Object.assign(extensions, commands, helpers);
export { commands, helpers };
export default extensions;
