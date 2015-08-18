import _ from 'lodash';
import logger from './logger';
import { asyncMap } from 'asyncbox';

const NATIVE_WIN = "NATIVE_APP";
const WEBVIEW_WIN = "WEBVIEW";
const WEBVIEW_BASE = WEBVIEW_WIN + "_";
const CHROMIUM_WIN = "CHROMIUM";

let helpers = {};

// This function gets a list of android system processes and returns ones
// that look like webviews, with the appropriate webview prefix and their PID
async function webviewsFromProcs (adb, deviceSocket) {
  let webviews = [];
  let out = await adb.shell("cat", ["/proc/net/unix"]);
  for (let line of out.split("\n")) {
    line = line.trim();
    let webviewPid = line.match(/@?webview_devtools_remote_(\d+)/);
    if (deviceSocket) {
      if (line.indexOf("@" + deviceSocket) === line.length - deviceSocket.length - 1) {
        if (webviewPid) {
          webviews.push(WEBVIEW_BASE + webviewPid[1]);
        } else {
          webviews.push(CHROMIUM_WIN);
        }
      }
    } else if (webviewPid) {
      // for multiple webviews a list of 'WEBVIEW_<index>' will be returned
      // where <index> is zero based (same is in selendroid)
      webviews.push(WEBVIEW_BASE + webviewPid[1]);
    }
  }
  return _.uniq(webviews);
}

// Take a webview name like WEBVIEW_4296 and use 'adb shell ps' to figure out
// which app package is associated with that webview. One of the reasons we
// want to do this is to make sure we're listing webviews for the actual AUT,
// not some other running app
async function procFromWebview (adb, webview) {
  // webview_devtools_remote_4296 => 4296
  let pid = webview.match(/\d+$/);
  if (!pid) {
    throw new Error(`Could not find PID for webview ${webview}`);
  }
  pid = pid[0];
  logger.debug(`${webview} mapped to pid ${pid}`);
  logger.debug("Getting process name for webview");
  let out = await adb.shell("ps");
  let pkg = "unknown";
  let lines = out.split(/\r?\n/);
  /* Output of ps is like:
   USER     PID   PPID  VSIZE  RSS     WCHAN    PC         NAME
   u0_a136   6248  179   946000 48144 ffffffff 4005903e R com.example.test
  */
  let header = lines[0].trim().split(/\s+/);
  // the column order may not be identical on all androids
  // dynamically locate the pid and name column.
  let pidColumn = header.indexOf("PID");
  let pkgColumn = header.indexOf("NAME") + 1;

  for (let line of lines) {
    line = line.trim().split(/\s+/);
    if (line[pidColumn].indexOf(pid) !== -1) {
      logger.debug(`Parsed pid: ${line[pidColumn]} pkg: ${line[pkgColumn]}`);
      logger.debug(`from: ${line}`);
      pkg = line[pkgColumn];
      break;
    }
  }
  logger.debug(`returning process name: ${pkg}`);
  return pkg;
}

helpers.getWebviews = async function (adb, deviceSocket) {
  logger.debug("Getting a list of available webviews");
  let webviews = await webviewsFromProcs(adb, deviceSocket);

  if (deviceSocket) {
    return webviews;
  }

  webviews = await asyncMap(webviews, async (webviewName) => {
    let pkg = await procFromWebview(adb, webviewName);
    return WEBVIEW_BASE + pkg;
  });
  logger.debug(`Found webviews: ${JSON.stringify(webviews)}`);
  return webviews;
};

helpers.decorateChromeOptions = function (caps, opts, deviceId) {
  // add options from appium session caps
  if (opts.chromeOptions) {
    for (let [opt, val] of _.pairs(opts)) {
      if (_.isUndefined(caps.chromeOptions[opt])) {
        caps.chromeOptions[opt] = val;
      } else {
        logger.warn(`Cannot pass option ${caps.chromeOptions[opt]} because ` +
                    "Appium needs it to make chromeDriver work");
      }
    }
  }

  // add device id from adb
  caps.chromeOptions.androidDeviceSerial = deviceId;
  return caps;
};

export default helpers;
export { NATIVE_WIN, WEBVIEW_WIN, WEBVIEW_BASE, CHROMIUM_WIN };
