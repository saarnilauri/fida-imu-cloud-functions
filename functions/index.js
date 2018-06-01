/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for t`he specific language governing permissions and
 * limitations under the License.
 */
'use strict';

const functions = require('firebase-functions');
const mkdirp = require('mkdirp-promise');
// Include a Service Account Key to use a Signed URL
const gcs = require('@google-cloud/storage')({keyFilename: 'service-account-credentials.json'});
const admin = require('firebase-admin');
admin.initializeApp();
const spawn = require('child-process-promise').spawn;
const path = require('path');
const os = require('os');
const fs = require('fs');

// Max height and width of the thumbnail in pixels.
const THUMB_MAX_HEIGHT = 200;
const THUMB_MAX_WIDTH = 200;
const TINY_THUMB_MAX_WIDTH = 35;
const TINY_THUMB_MAX_HEIGHT = 35;

// Thumbnail prefix added to file names.
const THUMB_PREFIX = 'thumb_';
const TINY_THUMB_PREFIX = 'tinythumb_';

/**
 * When an image is uploaded in the Storage bucket We generate a thumbnail automatically using
 * ImageMagick.
 * After the thumbnail has been generated and uploaded to Cloud Storage,
 * we write the public URL to the Firebase Realtime Database.
 */
exports.generateThumbnail = functions.storage.object().onFinalize((object) => {
  // File and directory paths.
  const filePath = object.name;
  const contentType = object.contentType; // This is the image MIME type
  const fileDir = path.dirname(filePath);
  const pathArray = fileDir.split('/');
  const parentFolder = pathArray[pathArray.length-1]
  const fileName = path.basename(filePath);
  const thumbFilePath = path.normalize(path.join(fileDir, `${THUMB_PREFIX}${fileName}`));
  const tinyThumbFilePath = path.normalize(path.join(fileDir, `${TINY_THUMB_PREFIX}${fileName}`));
  const tempLocalFile = path.join(os.tmpdir(), filePath);
  const tempLocalDir = path.dirname(tempLocalFile);
  const tempLocalThumbFile = path.join(os.tmpdir(), thumbFilePath);
  const tempLocalTinyThumbFile = path.join(os.tmpdir(), tinyThumbFilePath);

  // Exit if this is triggered on a file that is not an image.
  if (!contentType.startsWith('image/')) {
    console.log('This is not an image.');
    return null;
  }

  // Exit if the image is already a thumbnail.
  if (fileName.startsWith(THUMB_PREFIX) || fileName.startsWith(TINY_THUMB_PREFIX)) {
    console.log('Already a Thumbnail.');
    return null;
  }

  // Cloud Storage files.
  const bucket = gcs.bucket(object.bucket);
  const file = bucket.file(filePath);
  const thumbFile = bucket.file(thumbFilePath);
  const tinyThumbFile = bucket.file(tinyThumbFilePath);
  const metadata = {
    contentType: contentType,
    // To enable Client-side caching you can set the Cache-Control headers here. Uncomment below.
    // 'Cache-Control': 'public,max-age=3600',
  };
  
  // Create the temp directory where the storage file will be downloaded.
  return mkdirp(tempLocalDir).then(() => {
    // Download file from bucket.
    return file.download({destination: tempLocalFile});
  }).then(() => {
    console.log('The file has been downloaded to', tempLocalFile);
    // Generate a thumbnail using ImageMagick.
    return spawn('convert', [tempLocalFile, '-thumbnail', `${THUMB_MAX_WIDTH}x${THUMB_MAX_HEIGHT}>`, tempLocalThumbFile], {capture: ['stdout', 'stderr']});
  }).then(() => {
    console.log('Thumbnail created at', tempLocalThumbFile);
    // Uploading the Thumbnail.
    return bucket.upload(tempLocalThumbFile, {destination: thumbFilePath, metadata: metadata});
  }).then(() => {
    // Generate a thumbnail using ImageMagick.
    return spawn('convert', [
      tempLocalFile,
      '-resize',
      `${TINY_THUMB_MAX_WIDTH}x${TINY_THUMB_MAX_HEIGHT}^`,
      '-gravity',
      'center',
      '-crop',
      `${TINY_THUMB_MAX_WIDTH}x${TINY_THUMB_MAX_HEIGHT}+0+0`,
      '+repage',
      tempLocalTinyThumbFile
    ], {capture: ['stdout', 'stderr']});

  }).then(() => {
    console.log('Tiny thumbnail created at', tempLocalTinyThumbFile);
    // Uploading the Thumbnail.
    return bucket.upload(tempLocalTinyThumbFile, {destination: tinyThumbFilePath, metadata: metadata});
  }).then(() => {
    console.log('Thumbnail uploaded to Storage at', thumbFilePath);
    // Once the image has been uploaded delete the local files to free up disk space.
    fs.unlinkSync(tempLocalFile);
    fs.unlinkSync(tempLocalThumbFile);
    fs.unlinkSync(tempLocalTinyThumbFile);
    // Get the Signed URLs for the thumbnail and original image.
    const config = {
      action: 'read',
      expires: '03-01-2500',
    };
    return Promise.all([
      thumbFile.getSignedUrl(config),
      file.getSignedUrl(config),
      tinyThumbFile.getSignedUrl(config),
    ]);
  }).then((results) => {
    console.log('Got Signed URLs.');
    const thumbResult = results[0];
    const originalResult = results[1];
    const tinyThumbResult = results[2];
    const thumbFileUrl = thumbResult[0];
    const fileUrl = originalResult[0];
    const tinyThumbFileUrl = tinyThumbResult[0];
    // Add the URLs to the Database
    return admin.database().ref('images').push({name: filePath, fullsize: fileUrl, thumbnail: thumbFileUrl, tiny: tinyThumbFileUrl, parentFolder});
  }).then(() => console.log('Thumbnails URLs saved to database.'));
});