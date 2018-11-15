const async = require('async');
const mongoose = require('mongoose');
const puppeteer = require('puppeteer');

require('dotenv').config();

mongoose.Promise = global.Promise;

const URL = 'http://www.todotango.com/musica/obras/partituras/-/0/0/';
// const URL = 'http://www.todotango.com/musica/obras/partituras/a/0/0/';

const scrapeLinks = () =>
  Array
    .from(document.querySelectorAll('.col-xs-12 .itemlista > a'))
    .map((el) => ({
      title: el.getAttribute('title'),
      href: el.getAttribute('href'),
    }))
    .slice(0, 50);

const scrapePage = () => {
  const isNotPixel = (s) => !/pixel\.gif/gi.test(s);

  const nullIfPixel = (s) => isNotPixel(s) ? s : null;

  const getTitle = () =>
    document.querySelector('span#main_Tema1_lbl_Titulo').innerText;

  const getGenre = () =>
    document.querySelector('span#main_Tema1_lbl_Ritmo').innerText;

  const getMusicAuthors = () =>
    Array
      .from(document.querySelectorAll('span#main_Tema1_Tema_Autores1_lbl_TituloAutoresMusica ~ span a'))
      .map((a) => a.innerText);

  const getLyricAuthors = () =>
    Array
      .from(document.querySelectorAll('span#main_Tema1_Tema_Autores1_lbl_TituloAutoresLetra ~ span a'))
      .map((a) => a.innerText);

  const getCover = () => {
    const source = nullIfPixel(document.querySelector('img#main_Tema1_img_part').getAttribute('src'));
    return source === null ? null : { source };
  };

  const getScores = () =>
    Array
      .from(document.querySelectorAll('div#partitura div.cajita_gris2 div img'))
      .map((image) => image.getAttribute('src'))
      .filter(isNotPixel)
      .map((url) => ({ url }));

  const getLyrics = () => {
    const text = document.querySelector('div#letra span#main_Tema1_lbl_Letra').innerText;
    return text === '' ? null : { text };
  };

  const getSource = () => ({ url: window.location.href });

  const getDuration = (s) => {
    const [minutes, seconds] = s.replace(/(\d+)&#39;(\d+)&quot;/gi, '$1:$2').split(':');
    return parseInt(minutes, 10) * 60 + parseInt(seconds, 10);
  };

  const getPlaylist = () => {
    const outerHtml = document.documentElement.outerHTML;
    const js = /new Playlist\(\"\d+\", (\[(.|[\r\n])*\])[\s\r\n]*\, \{(.|[\r\n])*\}\);/gi.exec(outerHtml);

    if (!js) {
      return null;
    }

    const playlist = window.eval(js[1]);

    return playlist.map((item) => ({
      title: item.titulo,
      description: item.detalles,
      duration: getDuration(item.duracion),
      formats: [
        { format: 'ogg', url: item.oga },
        { format: 'mp3', url: item.mp3 },
      ],
    }))
  };

  return {
    title: getTitle(),
    genre: getGenre(),
    poetry: getLyricAuthors(),
    music: getMusicAuthors(),
    scores: getScores(),
    lyrics: getLyrics(),
    cover: getCover(),
    playlist: getPlaylist(),
    source: getSource(),
  };
};

const scrape = async (url) => {
  console.log('Launching headless chrome...');
  const browser = await puppeteer.launch();

  console.log('Creating new chrome page...');
  const linksPage = await browser.newPage();

  console.log('Navigating to links page... (' + url + ')');
  await linksPage.goto(url, { timeout: 999999 }); // this page might be slow

  console.log('Scraping links...');
  const links = await linksPage.evaluate(scrapeLinks);

  console.log('Scraping individual pages...');
  const output = [];

  async.eachLimit(links, 3, (link, callback) => {
    console.log(`Loading page ${link.href}...`);
    browser.newPage()
      .then((page) =>
        page
          .goto(link.href)
          .then(() =>
            page.evaluate(scrapePage)
              .then((data) => output.push(data))
          )
        )
        .then(() => callback(null))
        .catch((err) => callback(err));
  }, (err) => {
    if (err) {
      console.error(err);
      browser.close();

      return;
    }

    // fs.writeFileSync('output.json', JSON.stringify(output, null, 2));

    const connection = mongoose.connection;

    connection.on('error', (e) => {
      console.error('MongoDB connection error', e);

      connection.close();

      browser.close();
    });

    connection.once('open', () => {
      console.log('Connected to MongoDB');

      const LyricsSchema = new mongoose.Schema({
        text: { type: String, default: null }
      }, { _id: false });

      const AudioFormat = new mongoose.Schema({
        format: { type: String, required: true },
        url: { type: String, required: true },
      }, { _id: false });

      const PlaylistSchema = new mongoose.Schema({
        title: { type: String, required: true },
        description: { type: String, required: true },
        duration: { type: Number, default: 0 },
        formats: { type: [AudioFormat], required: true },
      }, { _id: false });

      const SourceSchema = new mongoose.Schema({
        url: { type: String, required: true },
      }, { _id: false });

      const ImageSchema = new mongoose.Schema({
        url: { type: String, required: true },
      }, { _id: false });

      const PartituraSchema = new mongoose.Schema({
        title: { type: String, required: true },
        genre: { type: String, default: null },
        music: { type: [String], default: null },
        poetry: { type: [String], default: null },
        scores: { type: [ImageSchema], default: null },
        lyrics: { type: LyricsSchema, default: null },
        cover: { type: ImageSchema, default: null },
        playlist: { type: PlaylistSchema, default: null },
        source: { type: SourceSchema, default: null },
      });

      const Partitura = mongoose.model('Partitura', PartituraSchema);

      async.each(output, (item, callback) => {
        console.log(`Saving ${item.title} to MongoDB...`);
        new Partitura(item).save()
          .then(callback)
          .catch(callback);
      }, () => {
        console.log('Saved data');
        console.log('Closing connection to MongoDB...');
        connection.close();

        console.log('Shutting down chrome...');
        browser.close();
      });
    });

    mongoose.connect(process.env.MONGO_URI);
  });
};

scrape(URL);
