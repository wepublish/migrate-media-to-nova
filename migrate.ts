
import ApolloClient, { gql } from 'apollo-boost';
import axios from 'axios';
import { promises, readdirSync, createReadStream, copyFileSync, unlinkSync, renameSync } from 'fs';
import FormData from 'form-data';
import * as path from 'path';

const writeFile = promises.writeFile;
const stat = promises.stat;


const API_URL=`${process.env.API_URL}/v1/admin`
const API_USER= process.env.API_USER
const API_PASSWORD= process.env.API_PASSWORD
const bearerToken=process.env.BEARER_TOKEN
const newMediaServerUrl = process.env.MEDIA_SERVER_URL

const DOWNLOAD_NOT_FOUND:string[]=[]


let gqlClient = new ApolloClient({
    uri: API_URL
})



const loginGQL = async ():Promise<any> => {
    const mutation = gql`
        mutation CreateSession($email: String!, $password: String!) {
            createSession(email: $email, password: $password) {
                token
            }
        }
    `
    const res = await gqlClient.mutate({
        mutation,
        variables: {
            email: API_USER,
            password: API_PASSWORD
        }
    })

    return new ApolloClient({
        uri: API_URL,
        credentials: 'include',
        headers: {
            authorization: 'Bearer ' + res.data.createSession.token
        }
    })
}

type Image = {
    id: string
    url: string
    createdAt: string
}

const fd = (d: number): string => {
    return d < 10? `0${d}`: `${d}`
}

const formatDate = (data: string): string => {
    const d = new Date(data)
    return `${d.getFullYear()}-${fd(d.getMonth())}-${fd(d.getDate())}-${fd(d.getHours())}-${fd(d.getMinutes())}-${fd(d.getSeconds())}-${d.getMilliseconds()}`
}


const getImages = async (): Promise<Image[]> => {
    const query = gql`
query Images($take: Int, $skip: Int, $sort: ImageSort, $order: SortOrder) {
  images(take: $take, skip: $skip, sort: $sort, order: $order) {
    nodes {
      id
      url
      createdAt
    }
  }
}
    `
    let page = 0
    let images:Image[] = []
    let rawImages: Image[] = []

    // Get users from WEP in 100 blocks (Max)
    while (page === 0 || rawImages.length !== 0) {
        console.log("Getting <" + page + "> page WEP images...")
        rawImages = (await gqlClient.query({
            query,
            variables: {
                take: 100,
                skip: page * 100,
                sort: "CREATED_AT",
                order: "DESCENDING"
            }
        }))?.data?.images?.nodes
        page++
        images = images.concat(rawImages)
    }
    return images
}



function getImageName(id:string,url:string,dateString:string) {
    return `${dateString}@@${id}@@${path.basename(url).slice(-150)}`
}

async function downloadImageIfNotExists(image: Image): Promise<string|null> {
    const {url, id} = image
    const outputDir="images/"
    const createDateString = formatDate(image.createdAt)
    try {
        // Get the image name from the URL
        const imageName = getImageName(id,url,createDateString);

        // Define the full path where the image will be saved
        const imagePath = path.join(outputDir, imageName);

        try {
            await stat(imagePath);
            console.log(`Image already exists at ${imagePath}`);
            return imagePath;
        } catch {
            try {
                const imagePathUploaded = `${imagePath}_uploaded`
                await stat(imagePathUploaded);
                console.log(`Uploaded Image already exists at ${imagePathUploaded}`);
                return imagePathUploaded;
            } catch {
                // File does not exist, proceed with download
            }
        }

        // Fetch the image
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'arraybuffer',
        });

        // Save the image to the file system
        await writeFile(imagePath, response.data);

        console.log(`Image downloaded and saved to ${imagePath}`);
        return imagePath;
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) {
            console.log('Image not found:', url);
            DOWNLOAD_NOT_FOUND.push(url)
            return null;
        }
        console.error('Error downloading or saving the image:', error);
        throw error;
    }
}

const uploadFile = async (filePath: string, imageId: string, date: string): Promise<void> => {
    const url = `${newMediaServerUrl}?imageId=${imageId}`;
    const form = new FormData();
    form.append('file', createReadStream(filePath));

    try {
        const response = await axios.post(url, form, {
            headers: {
                ...form.getHeaders(),
                Authorization: `Bearer ${bearerToken}`,
            },
        });
        console.log(`${date} - ${imageId} File uploaded successfully: ${JSON.stringify(response.data)}`);
    } catch (error) {
        console.error(`Error uploading file: ${error}`);
        throw error
    }
};



async function main() {
    const now = (new Date()).getTime()
    gqlClient = await loginGQL()
    const images = await getImages()
    let imageCtr=0
    let imageCount = images.length
    for (const image of images) {
            imageCtr++
            await downloadImageIfNotExists(image)
            console.log(`Download ${imageCtr}/${imageCount}`)
    }



    const files = readdirSync('./images', {withFileTypes: true})
        .filter(item => !item.isDirectory())
        .map(item => item.name).filter(name => !name.endsWith("_uploaded")).reverse()

    for (const file of files) {
        const match = file.match(/^(.+)@@(.+)@@(.+)$/);
        if(match) {
            const [fullName,date, id, filename] = match;
            const uploadPath = `/tmp/${filename}`
            const srcPath = `./images/${fullName}`
            await copyFileSync(srcPath, uploadPath)
            await uploadFile(uploadPath,id, date)
            await unlinkSync(uploadPath)
            await renameSync(srcPath, `${srcPath}_uploaded`);
        }
    }






}

main()

       
       
