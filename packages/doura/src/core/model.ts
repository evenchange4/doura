import { isPlainObject, hasOwn, isObject, def } from '../utils'
import { warn } from '../warning'
import {
  view as reactiveView,
  View,
  effectScope,
  EffectScope,
  draft,
  watch,
  snapshot,
  pauseTracking,
  resetTracking,
} from '../reactivity'
import {
  Views,
  State,
  AnyModel,
  AnyObjectModel,
  ModelState,
  ModelActions,
  ModelViews,
  validateModelOptions,
} from './modelOptions'
import {
  ModelPublicInstance,
  PublicInstanceProxyHandlers,
} from './modelPublicInstance'
import { queueJob, SchedulerJob } from './scheduler'
import { AnyObject } from '../types'

export enum ActionType {
  REPLACE = 'replace',
  MODIFY = 'modify',
  PATCH = 'patch',
}

export type UnSubscribe = () => void

export type PublicPropertiesMap = Record<string, (i: ModelInternal) => any>

export interface ProxyContext {
  _: ModelInternal<any>
}

export interface ModelAction {
  name: string
  args: any[]
}

export interface ActionListener {
  (action: ModelAction): any
}

export interface SubscriptionCallback {
  (event: ModelChangeEvent): any
}

export interface ActionBase<T = any> {
  type: string
  payload?: T
  // Allows any extra properties to be defined in an action.
  [extraProps: string]: any
}

export interface ModifyAction extends ActionBase {
  type: ActionType.MODIFY
}

export type PatchArgs = {
  patch: any
}

export interface PatchAction extends ActionBase {
  type: ActionType.PATCH
  args: PatchArgs
}

export interface ReplaceAction extends ActionBase {
  type: ActionType.REPLACE
}

export type Action = ModifyAction | PatchAction | ReplaceAction

export interface ModelChangeEventBase {
  type: ActionType
  // the model to which the event is attached.
  model: ModelPublicInstance<AnyModel>
  // the model that triggered the event.
  target: ModelPublicInstance<AnyModel>
}

export interface ModelModifyEvent extends ModelChangeEventBase {
  type: ActionType.MODIFY
}

export interface ModelPatchEvent extends ModelChangeEventBase, PatchArgs {
  type: ActionType.PATCH
}

export interface ModelReplaceEvent extends ModelChangeEventBase {
  type: ActionType.REPLACE
}

export type ModelChangeEvent =
  | ModelModifyEvent
  | ModelPatchEvent
  | ModelReplaceEvent

export const enum AccessContext {
  DEFAULT,
  VIEW,
}

export type ModelData<Model extends AnyModel> = {
  $state: ModelState<Model>
} & ModelState<Model> &
  ModelViews<Model>

export type ModelAPI<IModel extends AnyModel> = ModelData<IModel> &
  ModelActions<IModel>

function patchObj(base: Record<string, any>, patch: Record<string, any>) {
  const keys = Object.keys(patch)
  if (!keys.length) {
    return
  }

  keys.forEach((key) => {
    if (hasOwn(base, key) && isPlainObject(patch[key])) {
      patchObj(base[key], patch[key])
    } else {
      base[key] = patch[key]
    }
  })
}

export interface ModelInternalOptions {
  name?: string
  initState?: State
}

export class ModelInternal<IModel extends AnyObjectModel = AnyObjectModel> {
  name: string
  options: IModel

  ctx: Record<string, any>
  accessCache: Record<string, any>

  /**
   * proxy for public this
   */
  proxy: ModelPublicInstance<IModel>

  // props
  actions: ModelActions<IModel>
  views: Views<ModelViews<IModel>>
  viewInstances: View[] = []
  accessContext: AccessContext

  stateRef: {
    value: any
  }
  stateValue!: any
  effectScope: EffectScope

  isPrimitiveState!: boolean

  private _api: ModelData<IModel> | null = null
  private _initState: ModelState<IModel>
  private _currentState!: any
  private _actionListeners: Set<ActionListener> = new Set()
  private _subscribers: Set<SubscriptionCallback> = new Set()
  private _isDispatching: boolean
  private _draftListenerHandler: () => void
  private _watchStateChange: boolean = true

  constructor(model: IModel, { name, initState }: ModelInternalOptions) {
    this.patch = this.patch.bind(this)
    this.onAction = this.onAction.bind(this)
    this.subscribe = this.subscribe.bind(this)
    this.isolate = this.isolate.bind(this)
    this.getApi = this.getApi.bind(this)

    this.options = model
    this.name = name || ''
    this._isDispatching = false
    this._initState = initState || model.state
    this.stateRef = draft({
      value: this._initState,
    })
    const update: SchedulerJob = () => {
      this.dispatch({
        type: ActionType.MODIFY,
        payload: snapshot(this.stateRef.value, this.stateRef.value),
      })
    }
    this._draftListenerHandler = watch(this.stateRef, () => {
      if (this._watchStateChange) {
        queueJob(update)
      }
    })
    this._setState(this._initState)

    this.actions = Object.create(null)
    this.views = Object.create(null)
    this.accessContext = AccessContext.DEFAULT
    this.ctx = {}
    def(this.ctx, '_', this)
    this.accessCache = Object.create(null)
    this.proxy = new Proxy(
      this.ctx,
      PublicInstanceProxyHandlers
    ) as ModelPublicInstance<IModel>

    this.effectScope = effectScope()
    this._initActions()
    this._initViews()
  }

  patch(obj: AnyObject) {
    if (!isPlainObject(obj)) {
      if (process.env.NODE_ENV === 'development') {
        warn(
          `patch argument should be an object, but receive a ${Object.prototype.toString.call(
            obj
          )}`
        )
      }
      return
    }

    if (!this._currentState) {
      return
    }

    this._watchStateChange = false
    patchObj(this.proxy.$state, obj)
    this._watchStateChange = true

    this.dispatch({
      type: ActionType.PATCH,
      payload: snapshot(this.stateRef.value, this.stateRef.value),
      args: {
        patch: obj,
      },
    })
  }

  replace(newState: AnyObject) {
    this._watchStateChange = false
    this.stateRef.value = newState
    this._watchStateChange = true

    // invalid all views;
    for (const view of this.viewInstances) {
      view.effect.scheduler!()
    }

    this.dispatch({
      type: ActionType.REPLACE,
      payload: newState,
    })
  }

  getState() {
    return this._currentState
  }

  getApi() {
    if (this._api === null) {
      const data = (this._api = {
        ...this._currentState,
        ...this.views,
      })
      def(data, '$state', this._currentState)
      for (const action of Object.keys(this.actions)) {
        def(data, action, this.actions[action])
      }
    }

    return this._api!
  }

  onAction(listener: (action: ModelAction) => any) {
    this._actionListeners.add(listener)

    return () => {
      this._actionListeners.delete(listener)
    }
  }

  subscribe(listener: SubscriptionCallback) {
    this._subscribers.add(listener)

    return () => {
      this._subscribers.delete(listener)
    }
  }

  /**
   * Executes the given function in a scope where reactive values can be read,
   * but they cannot cause the reactive scope of the caller to be re-evaluated
   * when they change
   */
  isolate<T>(fn: (s: ModelState<IModel>) => T): T {
    pauseTracking()
    const res = fn(this.stateValue)
    resetTracking()
    return res
  }

  depend(dep: ModelInternal<any>) {
    // collection beDepends, a depends b, when b update, call a need trigger listener
    dep.subscribe((event) => {
      this._triggerListener({
        ...event,
        model: this.proxy,
      })
    })
  }

  createView(viewFn: (s: ModelState<IModel>) => any) {
    let view: View
    this.effectScope.run(() => {
      view = reactiveView(() => {
        const oldCtx = this.accessContext
        this.accessContext = AccessContext.VIEW
        try {
          let value = viewFn.call(this.proxy, this.proxy)
          if (process.env.NODE_ENV === 'development') {
            if (isObject(value)) {
              if (value === this.proxy) {
                warn(
                  `detect returning "this" in view, it would cause unpected behavior`
                )
              } else if (value === this.proxy.$state) {
                warn(
                  `detect returning "this.$state" in view, it would cause unpected behavior`
                )
              }
            }
          }
          return value
        } finally {
          this.accessContext = oldCtx
        }
      })
    })

    this.viewInstances.push(view!)
    return view!
  }

  reducer(state: ModelState<AnyModel>, action: Action) {
    switch (action.type) {
      case ActionType.REPLACE:
      case ActionType.MODIFY:
      case ActionType.PATCH:
        return action.payload
      default:
        return state
    }
  }

  dispatch(action: Action) {
    if (typeof action.type === 'undefined') {
      if (process.env.NODE_ENV === 'development') {
        warn(
          `Actions may not have an undefined "type" property. You may have misspelled an action type string constant.`
        )
      }
      return action
    }

    if (this._isDispatching) {
      if (process.env.NODE_ENV === 'development') {
        warn(`Cannot dispatch action from a reducer.`)
      }
      return action
    }

    let nextState

    try {
      this._isDispatching = true
      nextState = this.reducer(this._currentState, action)
    } finally {
      this._isDispatching = false
    }
    if (nextState !== this._currentState) {
      this._setState(nextState)
      this._triggerListener({
        type: action.type,
        model: this.proxy,
        target: this.proxy,
        ...action.args,
      })
    }

    return action
  }

  destroy() {
    this._api = null
    this._currentState = null
    this.stateRef = {
      value: null,
    }
    this._subscribers.clear()
    this.effectScope.stop()
    this._draftListenerHandler()
  }

  private _setState(newState: ModelState<IModel>) {
    this._api = null
    this._currentState = newState
    this.isPrimitiveState = !isObject(newState)
    this.stateValue = this.stateRef.value
  }

  private _triggerListener(event: ModelChangeEvent) {
    for (const listener of this._subscribers) {
      listener(event)
    }
  }

  private _initActions() {
    // map actions names to dispatch actions
    const actions = this.options.actions
    if (actions) {
      const actionKeys = Object.keys(actions)
      actionKeys.forEach((actionsName) => {
        const action = actions[actionsName]

        Object.defineProperty(this.actions, actionsName, {
          configurable: true,
          enumerable: true,
          writable: false,
          value: (...args: any[]) => {
            for (const listener of this._actionListeners) {
              listener({
                name: actionsName,
                args,
              })
            }

            return action.call(this.proxy, ...args)
          },
        })
      })
    }
  }

  private _initViews() {
    const views = this.options.views
    if (views) {
      for (const viewName of Object.keys(views)) {
        const viewFn = views[viewName]
        const view = this.createView(viewFn)

        const self = this
        Object.defineProperty(this.views, viewName, {
          configurable: true,
          enumerable: true,
          get() {
            const viewWithState = view as View & { __pre: any; __snapshot: any }
            let value = view.value
            if (view.mightChange) {
              view.mightChange = false
              viewWithState.__snapshot = snapshot(value, self.stateRef.value)
            } else if (viewWithState.__pre !== value) {
              viewWithState.__snapshot = snapshot(value, self.stateRef.value)
            }
            viewWithState.__pre = value

            return viewWithState.__snapshot
          },
          set() {
            if (process.env.NODE_ENV === 'development') {
              warn(`cannot change view property '${String(viewName)}'`)
            }
            return false
          },
        })
      }
    }
  }
}

export function createModelInstnace<IModel extends AnyObjectModel>(
  modelOptions: IModel,
  options: ModelInternalOptions = {}
) {
  if (process.env.NODE_ENV === 'development') {
    validateModelOptions(modelOptions)
  }

  return new ModelInternal<IModel>(modelOptions, options)
}
