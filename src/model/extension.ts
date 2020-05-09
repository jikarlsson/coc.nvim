import { spawn } from 'child_process'
import fs from 'fs'
import mkdirp from 'mkdirp'
import mv from 'mv'
import os from 'os'
import path from 'path'
import rc from 'rc'
import semver from 'semver'
import url from 'url'
import { promisify } from 'util'
import workspace from '../workspace'
import download from './download'
import fetch from './fetch'
import rimraf from 'rimraf'
const logger = require('../util/logger')('model-extension')

export interface Info {
  'dist.tarball'?: string
  'engines.coc'?: string
  version?: string
  name?: string
}

function registryUrl(scope = 'coc.nvim'): string {
  const result = rc('npm', { registry: 'https://registry.npmjs.org/' })
  const registry = result[`${scope}:registry`] || result.config_registry || result.registry as string
  return registry.endsWith('/') ? registry : registry + '/'
}

export default class ExtensionManager {
  constructor(private root: string) {
  }

  private checkFolder(): void {
    let { root } = this
    mkdirp.sync(root)
    mkdirp.sync(path.join(root, 'node_modules/.cache'))
  }

  private async getInfo(ref: string): Promise<Info> {
    if (ref.startsWith('https:')) return await this.getInfoFromUri(ref)
    let name: string
    let version: string
    if (ref.indexOf('@') > 0) {
      [name, version] = ref.split('@', 2)
    } else {
      name = ref
    }
    let res = await fetch(url.resolve(registryUrl(), name)) as any
    if (!version) version = res['dist-tags']['latest']
    let obj = res['versions'][version]
    if (!obj) throw new Error(`${ref} not exists.`)
    let requiredVersion = obj['engines'] && obj['engines']['coc']
    if (!requiredVersion) {
      throw new Error(`${ref} is not valid coc extension, "engines" field with coc property required.`)
    }
    return {
      'dist.tarball': obj['dist']['tarball'],
      'engines.coc': requiredVersion,
      version: obj['version'],
      name: res.name
    } as Info
  }

  private async _install(npm: string, def: string, info: Info, onMessage: (msg: string) => void): Promise<void> {
    let tmpFolder = await promisify(fs.mkdtemp)(path.join(os.tmpdir(), `${info.name}-`))
    let folder = path.join(this.root, 'node_modules', info.name)
    if (fs.existsSync(folder)) {
      let stat = fs.statSync(folder)
      if (!stat.isDirectory()) {
        onMessage(`${folder} is not directory, skipped install of ${info.name}`)
        return
      }
    }
    let url = info['dist.tarball']
    onMessage(`Downloading from ${url}`)
    await download(url, { dest: tmpFolder })
    let content = await promisify(fs.readFile)(path.join(tmpFolder, 'package.json'), 'utf8')
    let { dependencies } = JSON.parse(content)
    if (dependencies && Object.keys(dependencies).length) {
      onMessage(`Installing dependencies.`)
      let p = new Promise<void>((resolve, reject) => {
        let args = ['install', '--ignore-scripts', '--no-lockfile', '--production']
        if (info['dist.tarball'] && info['dist.tarball'].includes('github.com')) {
          args = ['install']
        }
        const child = spawn(npm, args, { cwd: tmpFolder })
        child.stderr.setEncoding('utf8')
        child.on('error', reject)
        let err = ''
        child.stderr.on('data', data => {
          err += data
        })
        child.on('exit', code => {
          if (code) {
            console.error(`${npm} install exited with ${code}, messages:\n${err}`)
          }
          resolve()
        })
      })
      await p
    }
    let jsonFile = path.join(this.root, 'package.json')
    let obj = JSON.parse(fs.readFileSync(jsonFile, 'utf8'))
    obj.dependencies = obj.dependencies || {}
    if (/^https?:/.test(def)) {
      obj.dependencies[info.name] = def
    } else {
      obj.dependencies[info.name] = '>=' + info.version
    }
    const sortedObj = { dependencies: {} }
    Object.keys(obj.dependencies).sort().forEach(k => {
      sortedObj.dependencies[k] = obj.dependencies[k]
    })
    fs.writeFileSync(jsonFile, JSON.stringify(sortedObj, null, 2), { encoding: 'utf8' })
    onMessage(`Moving to new folder.`)
    rimraf.sync(folder, { glob: false })
    await promisify(mv)(tmpFolder, folder, { mkdirp: true, clobber: true })
  }

  public async install(npm: string, def: string): Promise<string> {
    this.checkFolder()
    logger.info(`Using npm from: ${npm}`)
    logger.info(`Loading info of ${def}.`)
    let info = await this.getInfo(def)
    let { name } = info
    let required = info['engines.coc'] ? info['engines.coc'].replace(/^\^/, '>=') : ''
    if (required && !semver.satisfies(workspace.version, required)) {
      throw new Error(`${name} ${info.version} requires coc.nvim >= ${required}, please update coc.nvim.`)
    }
    await this._install(npm, def, info, msg => {
      logger.info(msg)
    })
    workspace.showMessage(`Installed extension: ${name}`, 'more')
    logger.info(`Installed extension: ${name}`)
    return name
  }

  public async update(npm: string, name: string, uri?: string): Promise<boolean> {
    this.checkFolder()
    let folder = path.join(this.root, 'node_modules', name)
    let stat = await promisify(fs.lstat)(folder)
    if (stat.isSymbolicLink()) {
      logger.info(`skipped update of ${name}`)
      return false
    }
    let version: string
    if (fs.existsSync(path.join(folder, 'package.json'))) {
      let content = await promisify(fs.readFile)(path.join(folder, 'package.json'), 'utf8')
      version = JSON.parse(content).version
    }
    logger.info(`Loading info of ${name}.`)
    let info = await this.getInfo(uri ? uri : name)
    if (version && info.version && semver.gte(version, info.version)) {
      logger.info(`Extension ${name} is up to date.`)
      return false
    }
    let required = info['engines.coc'] ? info['engines.coc'].replace(/^\^/, '>=') : ''
    if (required && !semver.satisfies(workspace.version, required)) {
      throw new Error(`${name} ${info.version} requires coc.nvim >= ${required}, please update coc.nvim.`)
    }
    await this._install(npm, uri ? uri : name, info, msg => { logger.info(msg) })
    workspace.showMessage(`Updated extension: ${name} to ${info.version}`, 'more')
    logger.info(`Update extension: ${name}`)
    return true
  }

  private async getInfoFromUri(uri: string): Promise<Info> {
    if (!uri.includes('github.com')) {
      throw new Error(`"${uri}" is not supported, coc.nvim support github.com only`)
    }
    uri = uri.replace(/\/$/, '')
    let fileUrl = uri.replace('github.com', 'raw.githubusercontent.com') + '/master/package.json'
    let content = await fetch(fileUrl)
    let obj = typeof content == 'string' ? JSON.parse(content) : content
    return {
      'dist.tarball': `${uri}/archive/master.tar.gz`,
      'engines.coc': obj['engines'] ? obj['engines']['coc'] : undefined,
      name: obj.name,
      version: obj.version
    }
  }
}
