const imagesPerPage = 6 * 3; // or however many you want
let currentPage = 1;

const imageContainer = document.getElementById("imageContainer");
const imageWrapper = document.getElementsByClassName("imageWrapper")[0];
const prevButton = document.getElementById("prevButton");
const nextButton = document.getElementById("nextButton");

async function deleteImage(url) {
    try {
        const res = await fetch('/delete', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ url: url }),
        });
        if (res.ok) {
            alert('Image deleted successfully');
            window.location.reload();
        } else {
            alert('Error deleting image');
        }
    } catch (error) {
        console.error('Error:', error);
    }
}

function deleteImageFromInput() {
    const imageUrl = document.querySelector('input[name="deleteImage"]').value;
    deleteImage(imageUrl);
}

function displayImages() {
  const startIndex = (currentPage - 1) * imagesPerPage;
  const endIndex = startIndex + imagesPerPage;

  const paginatedUploads = uploads.slice(startIndex, endIndex);
  const paginatedUploadNodes = paginatedUploads.map((upload) => {
    const newNode = imageWrapper.cloneNode(true);
    const img = newNode.querySelector("img");
    const a = newNode.querySelector("a");
    const deleteButton = newNode.querySelector(".delete-button");
    deleteButton.addEventListener("click", () => {
        deleteImage(upload);
    })
    img.src = upload;
    a.href = upload;
    return newNode;
  });

  imageContainer.innerHTML = '';
  imageContainer.append(...paginatedUploadNodes);
}

prevButton.addEventListener("click", () => {
  if (currentPage > 1) {
    currentPage--;
    displayImages();
  }
});

nextButton.addEventListener("click", () => {
  const maxPages = Math.ceil(uploads.length / imagesPerPage);
  if (currentPage < maxPages) {
    currentPage++;
    displayImages();
  }
});

displayImages();
