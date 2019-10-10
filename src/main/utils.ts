import fs from 'fs'
import os from 'os'
import path from 'path'
import plist from 'plist'
import { v4 } from 'uuid'
import { spawn } from 'child_process'
import { AppInfo, Dict } from '../types'
import { Store } from 'redux'
import {
  updateNodePort,
  updateWindowPort,
  addInstance,
  updateLog,
  removeInstance,
} from '../reducers/instance'
import { State } from '../reducers'

export const readIcnsAsImageUri = async (file: string) => {
  let buf = await fs.promises.readFile(file)
  const totalSize = buf.readInt32BE(4) - 8
  buf = buf.slice(8)

  const icons = []

  let start = 0
  while (start < totalSize) {
    const type = buf.slice(start, start + 4).toString()
    const size = buf.readInt32BE(start + 4)
    const data = buf.slice(start + 8, start + size)

    icons.push({ type, size, data })
    start += size
  }

  icons.sort((a, b) => b.size - a.size)
  const imageData = icons[0].data
  if (imageData.slice(1, 4).toString() === 'PNG') {
    return 'data:image/png;base64,' + imageData.toString('base64')
  }

  // TODO: other image type
  return ''
}

async function readdirAbsolute(dir: string) {
  try {
    const dirs = await fs.promises.readdir(dir)
    return dirs.map(file => path.join(dir, file))
  } catch (err) {
    return []
  }
}

async function getPossibleAppPaths() {
  switch (process.platform) {
    case 'win32': {
      const apps = await Promise.all(
        [
          os.homedir() + '/AppData/Local',
          'c:/Program Files',
          'c:/Program Files (x86)',
        ].map(dir => readdirAbsolute(dir)),
      )
      return apps.flat()
    }
    case 'darwin':
      return readdirAbsolute('/Applications')
    default:
      return []
  }
}

export async function getAppInfo(
  appPath: string,
): Promise<AppInfo | undefined> {
  switch (process.platform) {
    case 'win32': {
      try {
        const files = await fs.promises.readdir(appPath)

        const isElectronBased =
          fs.existsSync(path.join(appPath, 'resources/electron.asar')) ||
          files.some(dir => {
            return fs.existsSync(
              path.join(appPath, dir, 'resources/electron.asar'),
            )
          })

        if (!isElectronBased) return

        // TODO: The first one
        const [exeFile] = files.filter(file => {
          return (
            file.endsWith('.exe') &&
            !['uninstall', 'update'].some(keyword =>
              file.toLowerCase().includes(keyword),
            )
          )
        })
        if (!exeFile) return

        return {
          id: v4(), // TODO: get app id from register
          name: path.basename(exeFile, '.exe'),
          icon: '', // TODO: icon
          appPath,
          exePath: path.resolve(appPath, exeFile),
        }
      } catch (err) {
        // catch errors of readdir
        // 1. file: ENOTDIR: not a directory
        // 2. no permission at windows: EPERM: operation not permitted
        // console.error(err.message)
        return
      }
    }
    case 'darwin': {
      const isElectronBased = fs.existsSync(
        path.join(appPath, 'Contents/Frameworks/Electron Framework.framework'),
      )
      if (!isElectronBased) return

      const infoContent = await fs.promises.readFile(
        path.join(appPath, 'Contents/Info.plist'),
        { encoding: 'utf8' },
      )
      const info = plist.parse(infoContent) as {
        CFBundleIdentifier: string
        CFBundleDisplayName: string
        CFBundleExecutable: string
        CFBundleIconFile: string
      }

      const icon = await readIcnsAsImageUri(
        path.join(appPath, 'Contents', 'Resources', info.CFBundleIconFile),
      )

      return {
        id: info.CFBundleIdentifier,
        name: info.CFBundleDisplayName,
        icon,
        appPath,
        exePath: path.resolve(
          appPath,
          'Contents/MacOS',
          info.CFBundleExecutable,
        ),
      }
    }
    default:
      throw new Error('platform not supported: ' + process.platform)
  }
}

export async function startDebugging(app: AppInfo, store: Store<State>) {
  const sp = spawn(app.exePath, [`--inspect=0`, `--remote-debugging-port=0`])

  const id = v4()
  store.dispatch(addInstance(id, app.id))

  const handleStdout = (isError = false) => (chunk: Buffer) => {
    const data = chunk.toString()
    const instance = store.getState().instanceInfo[id]

    // Try to find listening port from log
    if (!instance.nodePort) {
      const match = /Debugger listening on ws:\/\/127.0.0.1:(\d+)\//.exec(data)
      if (match) {
        store.dispatch(updateNodePort(id, match[1]))
      }
    }
    if (!instance.windowPort) {
      const match = /DevTools listening on ws:\/\/127.0.0.1:(\d+)\//.exec(data)
      if (match) {
        store.dispatch(updateWindowPort(id, match[1]))
      }
    }

    // TODO: stderr colors
    store.dispatch(updateLog(id, data))
  }

  sp.stdout.on('data', handleStdout())
  sp.stderr.on('data', handleStdout(true))

  sp.on('close', code => {
    // console.log(`child process exited with code ${code}`)
    store.dispatch(removeInstance(id))
  })

  sp.on('error', () => {
    // TODO:
  })
}

// Detect Electron apps
export async function getElectronApps() {
  const appPaths = await getPossibleAppPaths()
  const infos = [] as AppInfo[]
  for (let p of appPaths) {
    // TODO: parallel
    console.log(p)
    const info = await getAppInfo(p)
    if (info) {
      console.log(info.name)
      infos.push(info)
    }
  }

  return infos.reduce(
    (a, b) => {
      a[b.id] = b
      return a
    },
    {} as Dict<AppInfo>,
  )
}
