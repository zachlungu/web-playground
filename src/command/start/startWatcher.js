import { Observable } from 'rx';
import { wrap } from 'co';
import { curry, converge, prop, path, pipe, equals, defaultTo } from 'ramda';
import { safeDump } from 'js-yaml';
import { getConfigPath, getConfigGlobPattern, loadConfig } from '../../util/ConfigUtil';
import {
  getJsGlobPattern,
  getCssGlobPattern,
  getHtmlGlobPattern,
  getJsRender,
  getCssRender,
  getHtmlRender,
  getPostProcessorForCss
} from '../../util/AssetUtil';
import { watch, readToStr } from '../../util/FileUtil';
import { info, error } from '../../util/Log';
import { DEFAULT_CONFIG } from '../../CONST';

const getLocalsFromPlayground = converge(
  (title, cssBase, stylesheets, scripts) => ({title, cssBase, stylesheets, scripts}),
  [
    pipe(prop('title'), defaultTo(DEFAULT_CONFIG.title)),
    pipe(path(['css', 'base']), defaultTo(null)),
    pipe(path(['css', 'external']), defaultTo(null)),
    pipe(path(['js', 'external']), defaultTo(null))
  ]
);

const setLocals = curry(function (serveAssets, config) {
  pipe(getLocalsFromPlayground, serveAssets.setLocals)(config);
});

function processHtmlFile({targetDir}, serveAssets, config) {
  return watch(getHtmlGlobPattern(targetDir, config))
    .debounce(100)
    .flatMap(readToStr)
    .flatMap(getHtmlRender(config))
    .startWith('<div id="playground"></div>')
    .retry()
    .doOnNext(serveAssets.updateAsset('html'));
}

function processJsFile({targetDir}, serveAssets, config) {
  return watch(getJsGlobPattern(targetDir, config))
    .debounce(100)
    .flatMap(readToStr)
    .flatMap(getJsRender(config))
    .startWith("try {\n  document.getElementById('playground').innerHTML = 'hello, playground!';\n} catch (err) {}")
    .retry()
    .doOnNext(serveAssets.updateAsset('js'));
}

function processCssFile({targetDir}, serveAssets, config) {
  return watch(getCssGlobPattern(targetDir, config))
    .debounce(100)
    .flatMap(readToStr)
    .flatMap(getCssRender(config))
    .flatMap(getPostProcessorForCss(config))
    .startWith('#playground {\n  color: rebeccapurple;\n}')
    .retry()
    .doOnNext(serveAssets.updateAsset('css'));
}

const processAssetFiles = curry(function (opts, serveAssets, config) {
  return Observable.combineLatest(
    processJsFile(opts, serveAssets, config),
    processCssFile(opts, serveAssets, config),
    processHtmlFile(opts, serveAssets, config)
  );
});

/**
 * @param {Object}      opts
 * @param {string}      opts.targetDir
 * @param {boolean}     opts.liveReload
 * @param {ServeAssets} serveAssets
 * @param {BrowserSync} bs
 *
 * @return {void}
 */
export default wrap(function *({targetDir, liveReload}, serveAssets, bs) {

  const configGlobPattern = getConfigGlobPattern(targetDir);

  let configStream = watch(configGlobPattern).flatMap(loadConfig);

  const configPath = yield getConfigPath(targetDir);
  if (!configPath) {
    info('cannot find config file, use default configurations');
    configStream = configStream.startWith(DEFAULT_CONFIG);
  }

  configStream = configStream
    .distinctUntilChanged(null, equals)
    .doOnNext((config) => {
      info('config updated');
      info('--------------------------');
      info(safeDump(config, {indent: 4}));
    });

  let onlyCssChange = false;

  configStream
    .doOnNext(setLocals(serveAssets))
    .flatMap(processAssetFiles({ targetDir }, serveAssets))
    .distinctUntilChanged(null, ([js0, css0, html0], [js1, css1, html1]) => {
      onlyCssChange = (css0 !== css1) && (js0 === js1 && html0 === html1);
      return js0 === js1 && css0 === css1 && html0 === html1;
    })
    .subscribe(
      () => {
        if (liveReload) {
          if (onlyCssChange) {
            bs.reload('css.css');
          } else {
            bs.reload();
          }
        }
      },
      error);
});