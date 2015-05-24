/* global define */
define([
  "/socket.io/socket.io.js"
], function(
  Socket
) {
  "use strict";
  var socket = Socket.connect(location.origin);

  var Service = function(args) {
    this.name = args.name;
    this.type = args.type;
    this.client = args.client;
    this.id = args.id;
    this.config = args.config;
    this.isDestroy = false;
    // TODO: associate to Service for update it
    this.instance = {};
    this.observeHandlers = {};
    this.reconfigInstance();
    Object.defineProperty(this.instance, '_id', {
      configurable: false,
      enumerable: false,
      value: args.id,
      writable: false
    });
    Object.defineProperty(this.instance, 'destroy', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Service.destroyService
    });
  };

  Service.prototype.reconfigInstance = function() {
    Object.keys(this.instance).forEach(function(key) {
      delete this.instance[key];
    }, this);
    Object.keys(this.client).forEach(function(key) {
      var value = this.client[key];
      if (value === 'callable') {
        Object.defineProperty(this.instance, key, {
          configurable: true,
          enumerable: true,
          writable: false,
          value: Service.createCallable(key)
        });
      } else if (value === 'override') {
        if (typeof this.config[key] !== 'function') {
          return;
        }
        Object.defineProperty(this.instance, key, {
          configurable: true,
          enumerable: true,
          writable: false,
          value: Service.createOverride(key, this.config[key])
        });
      }
    }, this);
    Object.keys(this.client._sync).forEach(function(key) {
      Object.defineProperty(this.instance, key, {
        configurable: true,
        enumerable: true,
        get: Service.createSyncGetter(key),
        set: Service.createSyncSetter(key)
      });
    }, this);
  };

  Service.prototype.serviceCall = function(args, callback) {
    var func = this.instance[args.method];
    if (typeof func !== 'function') {
      return;
    }

    var resp = func.call(this.instance, args.args, args.id);
    if (callback) {
      callback(resp);
    }
  };

  Service.prototype.serviceSync = function(args) {
    if (args.op === 'delete') {
      delete this.client._sync[args.key];
      return;
    }
    this.client._sync[args.key] = args.data;
  };

  Service.prototype.observe = function(func, acceptList) {
    if (this.observeHandlers(func)) {
      return;
    }
    var handler = function(changes) {
      changes = changes.map(function(change) {
        change.object = this.instance;
      }, this);
      func.call(this.instance, changes);
    }.bind(this);
    this.observeHandlers[func] = handler;
    this._sync.observe(handler, acceptList);
  }

  Service.prototype.unobserve = function(func) {
    if (!this.observeHandlers(func)) {
      return;
    }
    var handler = this.observeHandlers[func];
    this._sync.unobserve(handler);
    delete this.observeHandlers[func];
  }

  Service.instance = {};
  Service.getService = function(args) {
    return Service.instance[args.id];
  };
  Service.setService = function(id, service) {
    Service.instance[id] = service;
  };
  Service.getServiceAndValidate = function(args) {
    var service = Service.getService(args);
    if (!service) {
      // TODO: error handler
      console.warn('invalid service');
      return null;
    }
    if (service.isDestroy) {
      console.warn('service destroyed');
      return null;
    }
    return service;
  };

  Service.createCallable = function(key) {
    return function(args, callback) {
      var service = Service.getServiceAndValidate({
        id: this._id
      });
      if (!service) {
        return;
      }
      socket.emit('service:request', {
        name: service.name,
        type: service.type,
        id: service.id,
        method: key,
        args: args
      }, function(resp) {
        if (typeof callback === 'function') {
          callback.call(this, resp);
        }
      }.bind(this));
    };
  };

  Service.createOverride = function(key, func) {
    return function() {
      var service = Service.getServiceAndValidate({
        id: this._id
      });
      if (!service) {
        return;
      }
      return func.apply(this, arguments);
    };
  };

  Service.createSyncGetter = function(key) {
    return function() {
      var service = Service.getServiceAndValidate({
        id: this._id
      });
      if (!service) {
        return;
      }
      return service.client._sync[key];
    };
  };

  Service.createSyncSetter = function(key) {
    return function(data, callback) {
      var service = Service.getServiceAndValidate({
        id: this._id
      });
      if (!service) {
        return;
      }
      service.client._sync[key] = data;
      socket.emit('service:sync', {
        name: service.name,
        type: service.type,
        id: service.id,
        op: 'update',
        key: key,
        data: data
      }, function(resp) {
        if (typeof callback === 'function') {
          callback.call(this, resp);
        }
      }.bind(this));
      return data;
    };
  };

  Service.destroyService = function() {
    var service = Service.getService({
      id: this._id
    });
    if (!service) {
      return;
    }
    socket.emit('service:disconnect', {
      name: service.name,
      type: service.type,
      id: service.id
    });
    service.isDestroy = true;
    Object.keys(service.observeHandlers).forEach(function(func) {
      service.unobserve(func);
    });
    Service.instance[service.id] = undefined;
  };

  Service.setWithCallback = function(service, name, data, callback) {
    Object.getOwnPropertyDescriptor(service, name).set.call(service, data, callback);
  }

  socket.on('service:request', function(args, callback) {
    console.info('service:request', args);
    var service = Service.getService(args);
    if (!service) {
      return;
    }
    service.serviceCall(args, callback);
  });

  socket.on('service:sync', function(args) {
    console.info('service:sync', args);
    var service = Service.getService(args);
    if (!service) {
      return;
    }
    service.serviceSync(args);
  });
  socket.on('test', function() {
    console.log('test');
  });
  socket.on('disconnect', function() {
    console.info('disconnect', arguments);
  });

  // name, type, config, callback
  Service.connectService = function(opts) {
    if (typeof opts.callback !== 'function') {
      console.warn('no callback');
      return;
    }
    socket.emit('service:connect', {
      name: opts.name,
      type: opts.type
    }, function(resp) {
      console.info('connect:resp', resp);
      if (typeof resp === 'string') {
        opts.callback.call(window, resp);
        return;
      }
      var service = new Service({
        name: resp.name,
        type: resp.type,
        id: resp.id,
        client: resp.client,
        config: opts.config
      });
      Service.setService(resp.id, service);
      opts.callback.call(window, service.instance);
    });
  };

  return {
    connectService: Service.connectService
  };
});

