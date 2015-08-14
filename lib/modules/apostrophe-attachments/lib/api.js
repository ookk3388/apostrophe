var _ = require('lodash');
var async = require('async');
var crypto = require('crypto');
var path = require('path');


module.exports = function(self, options) {

  // Accept a file as submitted by an HTTP file upload.
  // req is checked for permissions. The callback receives an error if any
  // followed by a file object.
  //
  // "file" should be an object with "name" and "path" properties.
  // "name" must be the name the user claims for the file, while "path"
  // must be the actual full path to the file on disk and need not have
  // any file extension necessarily.
  //
  // (Note that when using Express to handle file uploads,
  // req.files['yourfieldname'] will be such an object as long as you
  // configure jquery fileupload to submit one per request.)

  self.accept = function(req, file, callback) {
    var extension = path.extname(file.name);
    if (extension && extension.length) {
      extension = extension.substr(1);
    }
    extension = extension.toLowerCase();
    // Do we accept this file extension?
    var accepted = [];
    var group = _.find(self.fileGroups, function(group) {
      accepted.push(group.extensions);
      var candidate = group.extensionMaps[extension] || extension;
      if (_.contains(group.extensions, candidate)) {
        return true;
      }
    });
    if (!group) {
      return callback("File extension not accepted. Acceptable extensions: " + accepted.join(", "));
    }
    var image = group.image;
    var info = {
      _id: self.apos.utils.generateId(),
      length: file.length,
      group: group.name,
      createdAt: new Date(),
      name: self.apos.utils.slugify(path.basename(file.name, path.extname(file.name))),
      title: self.apos.utils.sortify(path.basename(file.name, path.extname(file.name))),
      extension: extension
    };

    function permissions(callback) {
      // TODO port permissions
      return callback(self.apos.permissions.can(req, 'edit-file') ? null : 'forbidden');
    }

    function md5(callback) {
      return self.md5(file.path, function(err, md5) {
        if (err) {
          return callback(err);
        }
        info.md5 = md5;
        return callback(null);
      });
    }

    function upload(callback) {
      if (image) {
        // For images we correct automatically for common file extension mistakes
        console.log(file.path);
        console.log('/attachments/' + info._id + '-' + info.name);
        return self.uploadfs.copyImageIn(file.path, '/attachments/' + info._id + '-' + info.name, function(err, result) {
          if (err) {
            return callback(err);
          }
          info.extension = result.extension;
          info.width = result.width;
          info.height = result.height;
          if (info.width > info.height) {
            info.landscape = true;
          } else {
            info.portrait = true;
          }
          return callback(null);
        });
      } else {
        // For non-image files we have to trust the file extension
        // (but we only serve it as that content type, so this should
        // be reasonably safe)
        return self.uploadfs.copyIn(file.path, '/attachments/' + info._id + '-' + info.name + '.' + info.extension, callback);
      }
    }

    function remember(callback) {
      info.ownerId = self.apos.permissions.getEffectiveUserId(req);
      info.createdAt = new Date();
      return self.db.insert(info, callback);
    }

    return async.series([ permissions, md5, upload, cache ], function(err) {
      return callback(err, info);
    });
  };

  self.md5 = function(filename, callback) {
    var fs = require('fs');

    var md5 = crypto.createHash('md5');

    var s = fs.ReadStream(filename);

    s.on('data', function(d) {
      md5.update(d);
    });

    s.on('error', function(err) {
      return callback(err);
    });

    s.on('end', function() {
      var d = md5.digest('hex');
      return callback(null, d);
    });
  };

  self.crop = function(_id, crop, callback) {
    var info;
    return async.series([
      function(callback) {
        self.files.findOne({ _id: _id }, function(err, _info) {
          info = _info;
          return callback(err);
        });
      }
    ], function(err) {
      if (!info) {
        console.error(err);
        return self.fail(req, res);
      }
      info.crops = info.crops || [];
      var existing = _.find(info.crops, crop);
      if (existing) {
        // We're done, this crop is already available
        return res.send({ status: 'ok' });
      }
      // Pull the original out of cloud storage to a temporary folder where
      // it can be cropped and popped back into uploadfs
      var originalFile = '/attachments/' + file._id + '-' + file.name + '.' + file.extension;
      var tempFile = self.uploadfs.getTempPath() + '/' + self.generateId() + '.' + file.extension;
      var croppedFile = '/attachments/' + file._id + '-' + file.name + '.' + crop.left + '.' + crop.top + '.' + crop.width + '.' + crop.height + '.' + file.extension;

      return async.series([
        function(callback) {
          self.uploadfs.copyOut(originalFile, tempFile, callback);
        },
        function(callback) {
          self.uploadfs.copyImageIn(tempFile, croppedFile, { crop: crop }, callback);
        },
        function(callback) {
          info.crops.push(crop);
          self.db.update({ _id: info._id }, info, callback);
        }
      ], function(err) {
        // We're done with the temp file. We don't care if it was never created.
        fs.unlink(tempFile, function() { });
        if (err) {
          return res.send({ status: 'error' });
        } else {
          return res.send({ status: 'ok' });
        }
      });
    });
  };

  self.sanitizeCrop = function(crop) {
    crop = _.pick(crop, 'top', 'left', 'width', 'height');
    crop.top = self.apos.launder.integer(crop.top, 0, 0, 10000);
    crop.left = self.apos.launder.integer(crop.left, 0, 0, 10000);
    crop.width = self.apos.launder.integer(crop.width, 1, 1, 10000);
    crop.height = self.apos.launder.integer(crop.height, 1, 1, 10000);
    return crop;
  };

  self.middleware = {
    canUpload: function(req, res, next) {
      if (!self.apos.permissions.can(req, 'upload-attachment')) {
        res.statusCode = 403;
        return res.send("forbidden");
      }
      next();
    }
  };
}