const crypto = require('crypto');
const request = require('request-promise-native');
const sharp = require('sharp');
const { PubSub } = require(`@google-cloud/pubsub`);
const cloudinary = require('cloudinary');
const pRetry = require('p-retry');

const pubsub = new PubSub();

const createOrGetTopic = (type) => {
  const topicName = `${type}-image-processed`;
  return pubsub.createTopic(topicName)
    .then((results) => {
      const topic = results[0];
      console.log(`topic ${topic.name} created`);
      return topic;
    })
    .catch((err) => {
      if (err.code === 6) {
        return pubsub.topic(topicName);
      } else {
        console.error('failed to create topic', err);
      }
    });
};

const checksum = (str, algorithm = 'md5', encoding = 'hex') => {
  return crypto
    .createHash(algorithm)
    .update(str, 'utf8')
    .digest(encoding);
};

const uploadImage = (id, buffer, isGif, type, url) => {
  if (isGif) {
    return Promise.resolve(url);
  }

  const isSvg = url.indexOf('.svg') > 0;
  const fileName = checksum(buffer);
  const uploadPreset = isSvg ? undefined : `${type}_image`;

  console.log(`[${id}] uploading image ${fileName} with preset ${uploadPreset}`);

  return new Promise((resolve, reject) => {
    cloudinary.v2.uploader.upload_stream({ public_id: fileName, upload_preset: uploadPreset }, (err, res) => {
      if (err) {
        return reject(err);
      }

      resolve(cloudinary.v2.url(res.public_id, { secure: true, fetch_format: 'auto', quality: 'auto' }));
    })
      .end(buffer);
  });
};

const moderateContent = (url, title) => {
  const exclude = ['escort', 'sex'];
  if (title) {
    const lower = title.toLowerCase();
    const res = exclude.find(word => lower.indexOf(word) > -1);
    if (res) {
      return Promise.resolve(true);
    }
  }
  return Promise.resolve(false);
};

const downloadAndUpload = (id, url, type) => {
  console.log(`[${id}] downloading ${url}`);
  return request({
    method: 'GET',
    url,
    encoding: null,
  }).then((buffer) => {
    const image = sharp(buffer);
    return image.metadata()
      .then((info) => {
        console.log(`[${id}] processing image`);

        const ratio = info.width / info.height;
        const placeholderSize = Math.max(10, Math.floor(3 * ratio));

        const isGif = info.format === 'gif';
        const uploadPromise = uploadImage(id, buffer, isGif, type, url);

        const placeholderPromise = image.jpeg().resize(placeholderSize).toBuffer()
          .then(buffer => `data:image/jpeg;base64,${buffer.toString('base64')}`);

        return Promise.all([uploadPromise, placeholderPromise])
          .then(res => ({
            image: res[0],
            placeholder: res[1],
            ratio,
          }));
      });
  });
};

const manipulateImage = (id, url, title, type = 'post') => {
  if (!url) {
    console.log(`[${id}] no image, skipping image processing`);
    return Promise.resolve({});
  }

  return moderateContent(url, title)
    .then((rejected) => {
      if (rejected) {
        console.warn(`[${id}] image rejected ${url}`);
        return false;
      }

      return pRetry(() => downloadAndUpload(id, url, type), { retries: 5 })
        .catch((err) => {
          console.warn(err);
          return {};
        });
    })
    .catch((err) => {
      if (err.status === 400 || err.statusCode === 403) {
        console.warn(`[${id}] failed to check image ${url}`);
        return Promise.resolve({ image: null });
      }
      throw err;
    });
};

exports.imager = (event) => {
  const data = JSON.parse(Buffer.from(event.data, 'base64').toString());
  const type = data.type || 'post';

  return manipulateImage(data.id, data.image, data.title, type)
    .then(res => {
      if (res) {
        const item = Object.assign({}, data, res);
        return createOrGetTopic(type)
          .then((topic) => {
            console.log(`[${data.id}] ${type} image processed`, item);
            return topic.publish(Buffer.from(JSON.stringify(item)));
          });
      } else {
        console.warn(`[${data.id}] image rejected`);
      }
    })
    .catch((err) => {
      console.warn(`[${data.id}] failed to process image`, data, err);
      return data;
    });
};

// manipulateImage('', 'https://istio.io/img/istio-whitelogo-bluebackground-framed.svg', 'title')
// moderateContent('https://res.cloudinary.com/daily-now/image/upload/v1554148819/posts/f2d02c25a0221911f5446a8057872c05.jpg')
//   .then(console.log)
//   .catch(console.error);
