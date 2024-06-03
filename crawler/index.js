const got = require('got');
const langDetector = new (require('languagedetect'));
const metascraper = require('metascraper').load([
  require('metascraper-date')(),
  require('metascraper-url')(),
  require('./rules')(),
]);
const { PubSub } = require(`@google-cloud/pubsub`);
const pubsub = new PubSub();
const duplicateTags = require('./duplicate_tags');
const ignoredTags = require('./ignored_tags');
const pubTags = require('./pub_tags');
const topic = pubsub.topic('crawled-post');

const specificMetaFixes = (pubId, url, meta) => {
  switch (pubId) {
    case 'addy':
      // Addy Osmani blog has wrong twitter:url tag
      return Object.assign({}, meta, { url });
    case 'bair':
      // BAIR has wrong image url in the meta tags
      return Object.assign({}, meta, { image: meta.image.replace('blogassets', 'blog/assets') });
    default:
      return meta;
  }
};

const formatMeta = (meta) =>
  Object.assign({}, meta, {
    readTime: meta.readTime ? meta.readTime.duration : null,
    paid: meta.paid === 'true',
    isMediumComment: meta.isMediumComment === 'true',
  });

const extractMetaTags = (pubId, url) =>
  got(url)
    .then(({ body: html, url }) => metascraper({ html, url }))
    .then(res => specificMetaFixes(pubId, url, formatMeta(res)));

const convertTagsToSchema = (tags) => {
  const obj = Object.assign({}, tags);
  if (obj.date) {
    obj.publishedAt = new Date(obj.date);
  }
  delete obj.date;
  if (obj.modified) {
    obj.updatedAt = new Date(obj.modified);
  }
  delete obj.modified;
  if (obj.keywords) {
    obj.tags = obj.keywords;
  }
  delete obj.keywords;
  return obj;
};

const getIfTrue = (cond, key, value) => cond ? { [key]: value } : {};

const processTags = (data) => {
  let tags = data.tags || [];
  if (data.tags && data.tags.length) {
    tags = data.tags.map(t => {
      const newT = t.toLowerCase().split('&')[0].trim().replace(/ /g, '-');
      if (duplicateTags[newT]) {
        return duplicateTags[newT];
      }
      return newT;
    }).filter(t => t.length > 0 && ignoredTags.indexOf(t) < 0);
  }
  if (pubTags[data.publicationId]) {
    tags = tags.concat(pubTags[data.publicationId]);
  }
  tags = Array.from(new Set(tags));
  return Object.assign({}, data, { tags });
};

function isEnglish(text) {
  const langs = langDetector.detect(text, 10);
  return !!langs.find(l => l[0] === 'english');
}

exports.crawler = (event) => {
  const data = JSON.parse(Buffer.from(event.data, 'base64').toString());
  // Get rid of source=rss* added by Medium
  data.url = data.url.replace(/\?source=rss(.*)/, '');

  console.log(`[${data.id}] scraping ${data.url} to enrich`, data);

  return extractMetaTags(data.publicationId, data.url)
    .then(convertTagsToSchema)
    .then(tags => Object.assign({}, data, tags, getIfTrue(data.title && data.title.length < 255, 'title', data.title), getIfTrue(data.tags && data.tags.length > 0, 'tags', data.tags)))
    .catch((err) => {
      if (err.statusCode === 404) {
        console.info(`[${data.id}] post doesn't exist anymore ${data.url}`);
        return null;
      }

      console.warn(`[${data.id}] failed to scrape ${data.url}`, err);
      return data;
    })
    .then(processTags)
    .then((item) => {
      if (!item) {
        return Promise.resolve();
      }

      if (item.paid) {
        console.log(`[${data.id}] paid content is ignored`, item);
        return Promise.resolve();
      }

      if (item.isMediumComment && item.url.indexOf('medium.com') >= 0) {
        console.log(`[${data.id}] medium comment is ignored`, item);
        return Promise.resolve();
      }

      // if (!isEnglish(item.title)) {
      //   console.log(`[${data.id}] non-english content is ignored`, item);
      //   return Promise.resolve();
      // }

      if (item.tags && item.tags.indexOf('sponsored') > -1) {
        console.log(`[${data.id}] sponsored content is ignored`, item);
        return Promise.resolve();
      }

      console.log(`[${data.id}] crawled post`, item);
      return topic.publish(Buffer.from(JSON.stringify(item)));
    });
};

// const publicationId = 'dc';
// extractMetaTags(publicationId, 'https://firebase.googleblog.com/2020/03/firebase-kotlin-ga.html')
//   .then(convertTagsToSchema)
//   .then(data => processTags({ ...data, publicationId }))
//   .then(console.log)
//   .catch(console.error);
