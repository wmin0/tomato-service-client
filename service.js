/* global define */
define([
  "/socket.io/socket.io.js"
], function(
  Socket
) {
  "use strict";
  var socket = Socket.connect(location.origin);

  var FunctionMap = function() {
    this.keyArray = [];
    this.valueArray = [];
  };
  FunctionMap.prototype.get = function(key) {
    for (var i = 0; i < this.keyArray.length; ++i) {
      if (key === this.keyArray[i]) {
        return key;
      }
    }
  };
  FunctionMap.prototype.set = function(key, value) {
    for (var i = 0; i < this.keyArray.length; ++i) {
      if (key === this.keyArray[i]) {
        this.valueArray[i] = value;
        return;
      }
    }
    this.keyArray.push(key);
    this.valueArray.push(value);
  };
  FunctionMap.prototype.remove = function(key) {
    for (var i = 0; i < this.keyArray.length; ++i) {
      if (key === this.keyArray[i]) {
        this.keyArray = this.keyArray.slice(0, i).concat(this.keyArray.slice(i + 1));
        this.valueArray = this.valueArray.slice(0, i).concat(this.valueArray.slice(i + 1));
        return;
      }
    }
  };
  FunctionMap.keys = function(map) {
    return map.keyArray;
  };
  FunctionMap.values = function(map) {
    return map.valueArray;
  }

  var Service = function(args) {
    this.name = args.name;
    this.type = args.type;
    this.client = args.client;
    this.id = args.id;
    this.config = args.config;
    this.isDestroy = false;
    // TODO: associate to Service for update it
    this.instance = {};
    this.observeHandlers = new FunctionMap();
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
      value: Service.destroy
    });
    Object.defineProperty(this.instance, 'observe', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Service.observe
    });
    Object.defineProperty(this.instance, 'unobserve', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: Service.unobserve
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

  Service.destroy = function() {
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
    FunctionMap.values(service.observeHandlers).forEach(function(func) {
      Object.unobserve(service.client._sync, func);
    });
    Service.instance[service.id] = undefined;
  };

  Service.observe = function(func, acceptList) {
    var service = Service.getService({
      id: this._id
    });
    if (!service) {
      return;
    }
    if (service.observeHandlers.get(func)) {
      return;
    }
    var handler = function(changes) {
      changes = changes.map(function(change) {
        var obj = {};
        Object.getOwnPropertyNames(change).forEach(function(name) {
          var descriptor = Object.getOwnPropertyDescriptor(change, name);
          if (name === 'object') {
            descriptor.value = this;
          }
          Object.defineProperty(obj, name, descriptor);
        }, this);
        return obj;
      }, this);
      func.call(this, changes);
    }.bind(this);
    service.observeHandlers.set(func, handler);
    Object.observe(service.client._sync, handler, acceptList);
  }

  Service.unobserve = function(func) {
    var service = Service.getService({
      id: this._id
    });
    if (!service) {
      return;
    }
    if (!service.observeHandlers.get(func)) {
      return;
    }
    var handler = service.observeHandlers.get(func);
    Object.unobserve(service.client._sync, handler);
    service.observeHandlers.remove(func);
  }

  Service.setWithCallback = function(instance, name, data, callback) {
    Object.getOwnPropertyDescriptor(instance, name).set.call(instance, data, callback);
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
    connectService: Service.connectService,
    setWithCallback: Service.setWithCallback
  };
});

